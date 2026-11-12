import { randomUUID } from 'node:crypto';

/**
 * Client for the AG-UI protocol.
 *
 * AG-UI is not a duplex channel like ACP or Pi's RPC mode: one turn is one HTTP
 * `POST` of a `RunAgentInput` whose response is a Server-Sent Events stream of
 * typed events (`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, …
 * ending with `RUN_FINISHED` or `RUN_ERROR`). The client therefore holds no
 * process and no connection between turns — a conversation is tied together by
 * its `threadId`, which is what a later resume passes back.
 */

/** Budget of the liveness check; a local server answers in milliseconds. */
export const AGUI_PROBE_TIMEOUT_MS = 2_000;

/**
 * Vets the configured endpoint before anything is sent to it.
 *
 * The endpoint is the user's own configuration (`agui` on an `ICEBOX_AGENTS`
 * entry, or `ICEBOX_AGUI_URL`), so it sits at the same trust level as the agent
 * command the user wrote beside it and there is no fixed host to allowlist. What
 * can be rejected is a URL that is not a plain HTTP(S) address: other schemes
 * have no meaning for this protocol, and credentials embedded in the URL would
 * be echoed in error messages and the transcript.
 */
type AgUiEndpoint = URL;

function parseAgUiUrl(raw: string): AgUiEndpoint {
    let parsed: AgUiEndpoint;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(`"${raw}" is not a valid AG-UI endpoint URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`An AG-UI endpoint must be an http or https URL, not "${parsed.protocol}".`);
    }
    if (parsed.username || parsed.password) {
        throw new Error(`"${raw}" must not embed credentials; configure the server without them.`);
    }
    return parsed;
}

/** One message of the `RunAgentInput` history. */
export interface AgUiMessage {
    readonly id: string;
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly content: string;
}

/** One streamed event; `type` is the only field every event carries. */
export interface AgUiEvent extends Record<string, unknown> {
    readonly type: string;
}

/** What the connection reports while a run streams. */
export interface AgUiHandlers {
    readonly event: (event: AgUiEvent) => void;
}

/**
 * Whether `url` is a live AG-UI endpoint.
 *
 * Given that a run costs a turn and can mutate the thread, the check has to be
 * cheap. `HEAD` comes first: a network error or timeout means nothing is
 * listening, and 405/401/2xx all prove a server is there — the run itself then
 * reports a protocol problem instead of the chat quietly switching interfaces.
 *
 * The method is also the wrinkle: a route that only accepts `POST` answers 404 on
 * `HEAD` (Express and friends), which would look like a missing endpoint. One
 * `OPTIONS` follow-up asks which methods that route actually allows, so a
 * POST-only AG-UI route is recognised as available while a URL that is not there
 * stays unavailable.
 */
export async function probeAgUi(url: string, timeoutMs: number = AGUI_PROBE_TIMEOUT_MS): Promise<boolean> {
    const endpoint = parseAgUiUrl(url);
    const head = await ask(endpoint, 'HEAD', timeoutMs);
    if (!head) {
        return false;
    }
    if (head.status !== 404 && head.status !== 501) {
        return true;
    }
    const options = await ask(endpoint, 'OPTIONS', timeoutMs);
    if (!options) {
        return false;
    }
    const allowed = `${options.headers.get('allow') ?? ''},${options.headers.get('access-control-allow-methods') ?? ''}`;
    return allowed.toLowerCase().split(/[^a-z]+/).includes('post');
}

/** One request with its own deadline; `undefined` when the network fails. */
async function ask(endpoint: URL, method: string, timeoutMs: number): Promise<Response | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(endpoint, { method, signal: controller.signal, redirect: 'manual' });
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** One AG-UI endpoint: many runs over time, tied together by a thread id. */
export class AgUiConnection {
    private disposed = false;
    /**
     * Aborts the run in flight, not the connection.
     *
     * AG-UI has no cancel message — a run ends when its stream closes — so
     * interrupting means dropping the HTTP request. A fresh controller per run
     * keeps the thread usable afterwards, which is what makes "stop" different
     * from "close this tab".
     */
    private controller = new AbortController();

    constructor(readonly url: string, private readonly handlers: AgUiHandlers) {}

    get alive(): boolean {
        return !this.disposed;
    }

    /** Stops the current run; the connection stays usable for the next one. */
    abort(): void {
        if (this.disposed) {
            return;
        }
        this.controller.abort();
    }

    /** Aborts a run in flight; a connection cannot be reused afterwards. */
    dispose(): void {
        this.disposed = true;
        this.controller.abort();
    }

    /**
     * Sends one run and streams its events until the stream closes.
     *
     * Resolving means the run ended, which is the AG-UI equivalent of ACP
     * resolving its `session/prompt`: the turn is over, not merely accepted.
     */
    async run(threadId: string, messages: readonly AgUiMessage[], forwardedProps: Record<string, unknown>): Promise<void> {
        if (this.disposed) {
            throw new Error('This AG-UI connection is closed.');
        }
        const endpoint = parseAgUiUrl(this.url);
        // A run that ends (or is aborted) must not leave its controller behind: a
        // later prompt needs a live one, or it would return already-aborted.
        const controller = new AbortController();
        this.controller = controller;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({
                threadId,
                runId: randomUUID(),
                messages,
                tools: [],
                context: [],
                state: {},
                forwardedProps
            }),
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`The AG-UI endpoint answered ${response.status} ${response.statusText}.`);
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
            throw new Error(`The AG-UI endpoint answered "${contentType || 'no content type'}" instead of an event stream.`);
        }
        if (!response.body) {
            throw new Error('The AG-UI endpoint sent an empty response.');
        }
        await readEventStream(response.body, event => {
            if (!this.disposed) {
                this.handlers.event(event);
            }
        });
    }
}

/** An id for a message or run; AG-UI requires one per item. */
export function agUiId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
}

/**
 * Parses a `text/event-stream` body into events.
 *
 * Events are separated by a blank line and carry their payload in one or more
 * `data:` lines, which are concatenated. Comment, `event:` and `id:` lines are
 * ignored: AG-UI puts the event type *inside* the JSON payload, so the SSE
 * framing fields carry nothing this client needs.
 */
async function readEventStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: AgUiEvent) => void
): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const event = parseEventBlock(block);
                if (event) {
                    onEvent(event);
                }
                boundary = buffer.indexOf('\n\n');
            }
        }
        const trailing = parseEventBlock(buffer);
        if (trailing) {
            onEvent(trailing);
        }
    } finally {
        reader.releaseLock();
    }
}

function parseEventBlock(block: string): AgUiEvent | undefined {
    const data: string[] = [];
    for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) {
            continue;
        }
        data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) {
        return undefined;
    }
    const payload = data.join('\n').trim();
    // Transport-level terminators are not events.
    if (!payload || payload === '[DONE]') {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed !== 'object' || parsed === null) {
            return undefined;
        }
        const type = (parsed as Record<string, unknown>).type;
        if (typeof type !== 'string' || !type) {
            return undefined;
        }
        return parsed as AgUiEvent;
    } catch {
        // A malformed event is dropped rather than killing the run: the agent
        // keeps streaming and the transcript simply loses that fragment.
        return undefined;
    }
}
