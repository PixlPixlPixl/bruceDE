#!/usr/bin/env node
/**
 * A fake ACP agent, for the head-less checks.
 *
 * ACP is JSON-RPC over stdio, so a dozen lines are enough to exercise the client
 * honestly: `initialize`, repeated `session/new` on one connection, per-session
 * `session/prompt` and `session/cancel`. What it exists to prove is that two chat
 * sessions can share one process — it appends its pid to the file named by
 * `CHECK_PID_FILE`, so a caller can count the processes that answered.
 */
import { appendFileSync } from 'node:fs';

const pidFile = process.env.CHECK_PID_FILE;
if (pidFile) {
    appendFileSync(pidFile, `${process.pid}\n`);
}

let nextSession = 1;
const sessions = new Map();
const cancelled = new Set();

const write = payload => process.stdout.write(`${JSON.stringify(payload)}\n`);

/** Usage from the ACP shape, so the client's parser is exercised too. */
const usage = session => ({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedReadTokens: 2,
    contextWindowSize: 1000,
    contextTokens: 15,
    sessionId: session
});

const handlers = {
    initialize: () => ({
        protocolVersion: 1,
        // Resume is advertised, so the client is allowed to call session/load.
        agentCapabilities: { loadSession: true }
    }),

    'session/new': params => {
        const id = `sess-${nextSession++}`;
        sessions.set(id, []);
        // Commands are announced per session, through a notification rather than
        // the response, exactly as ACP agents do.
        write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                sessionId: id,
                update: {
                    sessionUpdate: 'available_commands_update',
                    availableCommands: [{ name: 'echo', description: 'echo a word' }]
                }
            }
        });
        return {
            sessionId: id,
            models: {
                currentModelId: 'stub-model',
                availableModels: [
                    { modelId: 'stub-model', name: 'Stub Model', description: 'the only model' }
                ]
            },
            cwd: params?.cwd
        };
    },

    'session/load': params => {
        const id = params?.sessionId ?? 'sess-load';
        sessions.set(id, ['restored']);
        write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                sessionId: id,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } }
            }
        });
        return { sessionId: id };
    },

    'session/prompt': params => {
        const id = params?.sessionId;
        if (!sessions.has(id)) {
            throw new Error(`unknown session ${id}`);
        }
        const text = (params?.prompt ?? []).map(part => part?.text ?? '').join('');
        if (cancelled.delete(id)) {
            return { stopReason: 'cancelled', usage: usage(id) };
        }
        // A tool call and an answer, so the transcript covers both shapes.
        write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                sessionId: id,
                update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'call-1',
                    title: 'stub',
                    kind: 'other',
                    status: 'completed'
                }
            }
        });
        write({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
                sessionId: id,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo ${text} from ${id}` } }
            }
        });
        return { stopReason: 'end_turn', usage: usage(id) };
    },

    'session/set_model': params => ({ sessionId: params?.sessionId, currentModelId: params?.modelId })
};

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) {
            continue;
        }
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            continue;
        }
        if (message.method === 'session/cancel') {
            cancelled.add(message.params?.sessionId);
            continue;
        }
        const handler = handlers[message.method];
        if (!handler) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no ${message.method}` } });
            continue;
        }
        try {
            write({ jsonrpc: '2.0', id: message.id, result: handler(message.params) });
        } catch (error) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error.message ?? error) } });
        }
    }
});

process.stdin.on('end', () => process.exit(0));
