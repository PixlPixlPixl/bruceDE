import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Minimal Agent Client Protocol (ACP) client.
 *
 * ACP is JSON-RPC 2.0 over the agent's stdio, one JSON object per line. This
 * module implements only the transport plus the four calls a chat panel needs:
 * `initialize`, `session/new`, `session/prompt` and the `session/update`
 * notifications that stream a turn. Everything else is answered with an
 * explicit JSON-RPC error so an agent cannot silently wait on us.
 */

export const ACP_PROTOCOL_VERSION = 1;

interface PendingCall {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
}

/** Callbacks for traffic the agent initiates. */
export interface AcpHandlers {
    /** Notification (`session/update`, …). Never expects a response. */
    readonly notification: (method: string, params: Record<string, unknown>) => void;
    /**
     * Request from the agent (`session/request_permission`, `fs/*`, …).
     * Return the `result` payload, or throw to answer with an error.
     */
    readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    /** The child exited, was killed, or could not start. */
    readonly exit: (reason: string) => void;
}

interface JsonRpcMessage {
    readonly id?: number | string | null;
    readonly method?: string;
    readonly params?: Record<string, unknown>;
    readonly result?: unknown;
    readonly error?: { readonly code?: number; readonly message?: string };
}

export class AcpConnection {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<number, PendingCall>();
    private buffer = '';
    private nextId = 1;
    private disposed = false;
    /** Last chunk of stderr, surfaced when the process dies unexpectedly. */
    private stderrTail = '';

    constructor(command: string, args: readonly string[], cwd: string, private readonly handlers: AcpHandlers) {
        this.child = spawn(command, [...args], { cwd });

        this.child.stdout.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
        this.child.stderr.setEncoding('utf8');
        this.child.stderr.on('data', (chunk: string) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-2000);
        });
        this.child.on('error', error => {
            this.fail(new Error(`Cannot start "${command}": ${error.message}`));
        });
        this.child.on('exit', (code, signal) => {
            this.fail(new Error(this.exitReason(code, signal)));
        });
    }

    get alive(): boolean {
        return !this.disposed && this.child.exitCode === null;
    }

    /** Sends a request and resolves with its `result`. */
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
        if (this.disposed) {
            throw new Error(`ACP connection is closed; cannot send "${method}".`);
        }
        const id = this.nextId++;
        const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        const response = new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.write(message);
        return (await response) as T;
    }

    /** Sends a notification (no response expected). */
    notify(method: string, params: Record<string, unknown>): void {
        this.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.rejectAll(new Error('ACP connection closed.'));
        try {
            this.child.kill();
        } catch {
            // Already gone; nothing to release.
        }
    }

    private write(payload: string): void {
        if (this.disposed) {
            return;
        }
        this.child.stdin.write(`${payload}\n`);
    }

    private receive(chunk: string): void {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) {
                this.dispatch(line);
            }
            newline = this.buffer.indexOf('\n');
        }
    }

    private dispatch(line: string): void {
        let message: JsonRpcMessage;
        try {
            message = JSON.parse(line) as JsonRpcMessage;
        } catch {
            // Non-JSON chatter on stdout is common in CLI wrappers; ignore it.
            return;
        }

        if (message.method !== undefined) {
            const params = message.params ?? {};
            if (message.id === undefined || message.id === null) {
                this.handlers.notification(message.method, params);
                return;
            }
            void this.answer(message.id, message.method, params);
            return;
        }

        if (typeof message.id !== 'number') {
            return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        this.pending.delete(message.id);
        if (message.error) {
            pending.reject(new Error(message.error.message ?? `ACP error ${message.error.code ?? ''}`.trim()));
        } else {
            pending.resolve(message.result);
        }
    }

    private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
        try {
            const result = await this.handlers.request(method, params);
            this.write(JSON.stringify({ jsonrpc: '2.0', id, result }));
        } catch (error) {
            this.write(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32601, message: error instanceof Error ? error.message : String(error) }
                })
            );
        }
    }

    private fail(error: Error): void {
        this.rejectAll(error);
        this.handlers.exit(error.message);
    }

    private rejectAll(error: Error): void {
        for (const [, pending] of this.pending) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    private exitReason(code: number | null, signal: string | null): string {
        const tail = this.stderrTail.trim();
        const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        return tail ? `Agent exited (${status}): ${tail.split('\n').slice(-3).join(' ')}` : `Agent exited (${status}).`;
    }
}

/** Result of the ACP `initialize` handshake. */
export interface AcpInitializeResult {
    readonly protocolVersion?: number;
    readonly authMethods?: readonly { readonly id: string; readonly name?: string }[];
    readonly agentCapabilities?: unknown;
}

/** One model an ACP agent offers; `session/set_model` takes its `modelId`. */
export interface AcpModelInfo {
    readonly modelId?: string;
    /** Some agents use `id` instead of the deprecated `modelId`. */
    readonly id?: string;
    readonly name?: string;
    readonly description?: string;
}

/** Create a session for `cwd`; resolves with the agent's session id. */
export interface AcpNewSessionResult {
    readonly sessionId: string;
    /** Model selection, advertised by agents that support `session/set_model`. */
    readonly models?: {
        readonly currentModelId?: string;
        readonly availableModels?: readonly AcpModelInfo[];
    };
}

/** Usage an agent may attach to a finished turn. */
export interface AcpPromptUsage {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cachedReadTokens?: number;
    readonly cachedWriteTokens?: number;
}

/** Result of `session/prompt`. */
export interface AcpPromptResult {
    readonly stopReason?: string;
    readonly usage?: AcpPromptUsage;
}

/** Typed view of the ACP calls this plugin uses. */
export class AcpClient {
    constructor(readonly connection: AcpConnection) { }

    initialize(): Promise<AcpInitializeResult> {
        return this.connection.request<AcpInitializeResult>('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            // No filesystem or terminal delegation: this client renders chat only.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
        });
    }

    async newSession(cwd: string): Promise<AcpNewSessionResult> {
        const result = await this.connection.request<AcpNewSessionResult>('session/new', {
            cwd,
            mcpServers: []
        });
        if (!result?.sessionId) {
            throw new Error('ACP agent did not return a session id.');
        }
        return result;
    }

    /** Starts one turn. Resolves when the agent finishes it. */
    prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
        return this.connection.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text }]
        });
    }

    /**
     * Switches the session's model.
     *
     * ACP marks this unstable: agents that do not advertise `models` in
     * `session/new` do not implement it, so the caller must only offer models the
     * agent actually listed.
     */
    setModel(sessionId: string, modelId: string): Promise<unknown> {
        return this.connection.request('session/set_model', { sessionId, modelId });
    }

    cancel(sessionId: string): void {
        this.connection.notify('session/cancel', { sessionId });
    }
}
