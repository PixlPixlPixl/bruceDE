import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnAgent } from './spawn.js';

/**
 * Minimal client for Pi's RPC mode (`pi --mode rpc`).
 *
 * Pi does not speak ACP: it exposes its own JSONL protocol on stdin/stdout —
 * commands in, correlated `response` records plus session events out. This
 * client implements only what a chat panel needs: the handshake, `prompt`,
 * `abort`, and event decoding. Framing follows the protocol documentation:
 * records are separated by LF only, so a readline-style splitter that also
 * breaks on U+2028/U+2029 would corrupt JSON strings.
 */

const HANDSHAKE_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 45_000;
/**
 * A prompt is answered as soon as Pi accepts it, but Pi may still be loading
 * extensions when the first prompt arrives, so this is not a model deadline.
 */
const PROMPT_ACCEPT_TIMEOUT_MS = 20_000;
const SHUTDOWN_GRACE_MS = 2_000;

interface PendingCommand {
    readonly resolve: (record: PiRpcRecord) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
}

export interface PiRpcRecord {
    readonly type?: string;
    readonly id?: string;
    readonly command?: string;
    readonly success?: boolean;
    readonly error?: string;
    readonly [key: string]: unknown;
}

/** Callbacks for everything Pi sends that is not a command response. */
export interface PiRpcHandlers {
    /** A session event (`agent_start`, `message_update`, `tool_execution_end`, …). */
    readonly event: (record: PiRpcRecord) => void;
    /** An `extension_ui_request`; dialog methods expect an answer. */
    readonly uiRequest: (record: PiRpcRecord) => void;
    /** The child exited, could not start, or was killed. */
    readonly exit: (reason: string) => void;
}

export class PiRpcConnection {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string, PendingCommand>();
    private buffer = '';
    private nextId = 1;
    private disposed = false;
    private stderrTail = '';

    constructor(command: string, args: readonly string[], cwd: string, private readonly handlers: PiRpcHandlers) {
        this.child = spawnAgent(command, args, cwd);

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

    /**
     * Runs the handshake and returns the `get_state` payload.
     *
     * `get_state` doubles as the availability check: a CLI that never answers
     * (wrong binary, missing auth, crashed on startup) fails here instead of
     * leaving the panel waiting on a prompt. The payload also carries the
     * session id and file a later resume needs.
     */
    async start(): Promise<Record<string, unknown> | undefined> {
        const response = await this.command({ type: 'get_state' }, HANDSHAKE_TIMEOUT_MS);
        return response.data as Record<string, unknown> | undefined;
    }

    /**
     * Submits a prompt. Resolves once Pi accepts or handles it.
     *
     * `streamingBehavior` is required while Pi is already streaming: `steer` is
     * delivered after the current assistant turn finishes its tool calls, and
     * `followUp` waits until the agent stops. Without it Pi rejects the prompt.
     */
    async prompt(text: string, streamingBehavior?: 'steer' | 'followUp'): Promise<{ readonly disposition?: string }> {
        const response = await this.command(
            streamingBehavior ? { type: 'prompt', message: text, streamingBehavior } : { type: 'prompt', message: text },
            PROMPT_ACCEPT_TIMEOUT_MS
        );
        const data = response.data as { disposition?: string } | undefined;
        return { disposition: data?.disposition };
    }

    /**
     * Sends any other RPC command and resolves with its `data`.
     *
     * The protocol is command-per-line, so new capabilities (`get_commands`,
     * `set_model`, `bash`, …) need no client changes: the caller names the command
     * and reads the documented payload.
     */
    async request<T>(command: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
        const response = await this.command(command, timeoutMs);
        return response.data as T;
    }

    /**
     * Aborts the current run. Pi answers once the session is idle, so the caller
     * must not await this before returning control to the user.
     */
    abort(): void {
        void this.command({ type: 'abort' }, COMMAND_TIMEOUT_MS).catch(() => undefined);
    }

    /** Answers an extension dialog; `cancelled` is the only safe default here. */
    answerUiRequest(id: string, response: Record<string, unknown>): void {
        this.write({ type: 'extension_ui_response', id, ...response });
    }

    /**
     * Orders a shutdown.
     *
     * Closing stdin is Pi's orderly path, and it waits for pending work; a
     * follow-up signal after the grace period guarantees the child cannot outlive
     * the plugin. The timer is unref'd so it never keeps Node alive.
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.rejectAll(new Error('Pi RPC connection closed.'));
        try {
            this.child.stdin.end();
        } catch {
            // Already closed.
        }
        const timer = setTimeout(() => {
            try {
                this.child.kill();
            } catch {
                // Already gone.
            }
        }, SHUTDOWN_GRACE_MS);
        timer.unref?.();
    }

    private command(command: Record<string, unknown>, timeoutMs: number): Promise<PiRpcRecord> {
        if (this.disposed) {
            throw new Error(`Pi RPC connection is closed; cannot send "${String(command.type)}".`);
        }
        const id = `req-${this.nextId++}`;
        const promise = new Promise<PiRpcRecord>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Pi did not answer "${String(command.type)}" within ${timeoutMs}ms.`));
            }, timeoutMs);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
        });
        this.write({ ...command, id });
        return promise;
    }

    private write(record: Record<string, unknown>): void {
        if (this.disposed) {
            return;
        }
        this.child.stdin.write(`${JSON.stringify(record)}\n`);
    }

    private receive(chunk: string): void {
        this.buffer += chunk;
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).replace(/\r$/, '');
            this.buffer = this.buffer.slice(newline + 1);
            if (line.trim()) {
                this.dispatch(line);
            }
            newline = this.buffer.indexOf('\n');
        }
    }

    private dispatch(line: string): void {
        let record: PiRpcRecord;
        try {
            record = JSON.parse(line) as PiRpcRecord;
        } catch {
            // Stdout is protocol-only, but a wrapper CLI may print a banner.
            return;
        }

        if (record.type === 'response') {
            const id = record.id;
            if (typeof id !== 'string') {
                return;
            }
            const pending = this.pending.get(id);
            if (!pending) {
                return;
            }
            this.pending.delete(id);
            clearTimeout(pending.timer);
            if (record.success === false) {
                pending.reject(new Error(record.error ?? `Pi rejected "${record.command ?? 'command'}".`));
            } else {
                pending.resolve(record);
            }
            return;
        }

        if (record.type === 'extension_ui_request') {
            this.handlers.uiRequest(record);
            return;
        }

        this.handlers.event(record);
    }

    private fail(error: Error): void {
        this.rejectAll(error);
        this.handlers.exit(error.message);
    }

    private rejectAll(error: Error): void {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private exitReason(code: number | null, signal: string | null): string {
        const tail = this.stderrTail.trim();
        const status = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        return tail
            ? `Pi exited (${status}): ${tail.split('\n').slice(-3).join(' ')}`
            : `Pi exited (${status}).`;
    }
}
