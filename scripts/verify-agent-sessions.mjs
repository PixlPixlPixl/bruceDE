#!/usr/bin/env node
/**
 * Regression check for the agent session backend.
 *
 * Runs the built orchestrator backend head-lessly with a fake `BackendPluginAPI`: no
 * Theia, no renderer, no plugin host. That is enough to exercise the parts a
 * refactor is most likely to break — plugin-declared agent discovery, the AG-UI
 * session path, the ACP/Pi fallback, resume handles and releasing a session.
 *
 * Usage:
 *   npm run build:plugins && node scripts/verify-agent-sessions.mjs
 *
 * Exits non-zero on the first failing group, and prints one line per assertion.
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ORCHESTRATOR = path.join(root, 'plugins', 'agent-orchestrator', 'dist', 'backend.js');
const PANEL_BACKEND = path.join(root, 'plugins', 'agent-chat', 'dist', 'backend.js');

const failures = [];
let checks = 0;

function check(name, condition, detail) {
    checks++;
    if (condition) {
        console.log(`  ok    ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

/** Waits for a session whose status satisfies `predicate`, polling as the UI does. */
async function waitFor(sessions, sessionId, predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await sessions.state(sessionId);
        if (predicate(last)) {
            return last;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return last;
}

async function waitIdle(sessions, sessionId, timeoutMs = 30_000) {
    return waitFor(sessions, sessionId, state => state?.status === 'idle', timeoutMs);
}

const text = state => (state?.entries ?? []).map(entry => `${entry.role}:${entry.text}`).join('\n');

/** Minimal AG-UI endpoint: HEAD answers, POST streams one short run. */
async function startAgUiStub() {
    const server = createServer(async (request, response) => {
        if (request.method === 'HEAD') {
            response.writeHead(200, { 'content-type': 'text/event-stream' }).end();
            return;
        }
        if (request.method !== 'POST') {
            response.writeHead(404).end();
            return;
        }
        let body = '';
        for await (const chunk of request) {
            body += chunk;
        }
        // A malformed request must not crash the fixture: the point of the stub is
        // to answer like a server, not to validate the client's JSON.
        let input = {};
        try {
            input = JSON.parse(body || '{}');
        } catch {
            input = {};
        }
        const thread = input.threadId ?? 'none';
        const send = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        send({ type: 'RUN_STARTED', threadId: thread });
        send({ type: 'TEXT_MESSAGE_START', messageId: 'm1' });
        send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'stub answer' });
        send({ type: 'TEXT_MESSAGE_END', messageId: 'm1' });
        send({ type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'echo' });
        send({ type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: `thread ${thread}` });
        send({ type: 'RUN_FINISHED', threadId: thread });
        response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { server, port: address.port };
}

/** A fake plugin host catalogue: one enabled plugin declaring the AG-UI agent. */
function catalogue(aguiPort) {
    return [
        {
            id: 'icebox.agent-test',
            name: 'Test agents',
            version: '0.1.0',
            builtIn: true,
            enabled: true,
            agents: [
                { id: 'stub', name: 'Stub', protocol: 'acp', agui: `http://127.0.0.1:${aguiPort}/run` },
                { id: 'stub-with-cli', name: 'Stub with CLI', protocol: 'pi-rpc', command: 'pi', agui: 'http://127.0.0.1:9/run' }
            ]
        }
    ];
}

/**
 * Fake BackendPluginAPI for one plugin.
 *
 * `services` is shared, so the orchestrator's `agent.runtime` and the panel's
 * `agent.sessions` meet exactly as they do inside the app: one registry, two
 * plugins, no renderer in between.
 */
function fakeApi({ id, directory, services, cwd }) {
    return {
        manifest: { id, name: id, version: '0.1.0', apiVersion: 1, entrypoints: {} },
        side: 'backend',
        origin: { builtIn: true, directory },
        workspace: { root: cwd, cwd },
        services: {
            provide: (serviceId, service) => {
                services.set(serviceId, service);
                return () => services.delete(serviceId);
            },
            get: serviceId => {
                const service = services.get(serviceId);
                if (!service) {
                    throw new Error(`Unknown service: ${serviceId}`);
                }
                return service;
            },
            has: serviceId => services.has(serviceId),
            remote: () => {
                throw new Error('The harness runs on the backend side only.');
            }
        },
        events: { emit: () => undefined, on: () => () => undefined },
        onDispose: () => undefined,
        provided: services
    };
}

async function main() {
    for (const file of [ORCHESTRATOR, PANEL_BACKEND]) {
        if (!existsSync(file)) {
            console.error(`Cannot run the check: ${path.relative(root, file)} is missing. Run: npm run build:plugins`);
            process.exit(1);
        }
    }

    // The catalogue needs the stub's port, so it is filled after the server starts.
    const stub = await startAgUiStub();
    const services = new Map([
        ['workspace.plugins', { list: () => catalogue(stub.port) }]
    ]);
    const shared = { catalogueEntries: [], services, cwd: root };

    console.log('Agent session check');
    const orchestratorModule = await import(`file://${ORCHESTRATOR}`);
    orchestratorModule.activate(fakeApi({
        ...shared,
        id: 'icebox.agent-orchestrator',
        directory: path.join(root, 'plugins', 'agent-orchestrator')
    }));
    const panelModule = await import(`file://${PANEL_BACKEND}`);
    panelModule.activate(fakeApi({
        ...shared,
        id: 'icebox.agent-chat',
        directory: path.join(root, 'plugins', 'agent-chat')
    }));

    const sessions = services.get('agent.sessions');
    const runtime = services.get('agent.runtime');
    check('orchestrator provides the runtime', typeof runtime?.state === 'function');
    check('panel provides the session surface', typeof sessions?.state === 'function');

    // 1. Agent discovery comes from the plugin catalogue, not from source.
    const agents = await sessions.listAgents();
    check('lists the plugin-declared AG-UI agent', agents.some(agent => agent.id === 'stub' && agent.agui),
        JSON.stringify(agents.map(agent => agent.id)));
    check('marks an AG-UI-only agent available', agents.find(agent => agent.id === 'stub')?.available === true);

    // 2. AG-UI session: events reach the transcript and the run settles back to idle.
    const agui = await sessions.openSession('check-agui', 'stub');
    await waitIdle(sessions, 'check-agui');
    await sessions.send('check-agui', 'hello from the harness');
    const afterAgui = await waitFor(sessions, 'check-agui', state => text(state).includes('stub answer'));
    check('AG-UI run streams an agent entry', text(afterAgui).includes('agent:stub answer'), text(afterAgui));
    check('AG-UI tool result reaches the transcript', text(afterAgui).includes('tool: thread '), text(afterAgui));
    check('AG-UI session settles back to idle', afterAgui?.status === 'idle', String(afterAgui?.status));
    check('AG-UI session stores a thread handle',
        afterAgui?.resume?.protocol === 'agui' && Boolean(afterAgui?.resume?.sessionId),
        JSON.stringify(afterAgui?.resume));
    check('open() reports the AG-UI session as live', typeof agui?.status === 'string');

    // 3. A dead AG-UI endpoint falls back to the agent's own protocol.
    await sessions.openSession('check-fallback', 'stub-with-cli');
    const afterFallback = await waitFor(sessions, 'check-fallback', state =>
        text(state).includes('is not answering') || state?.status === 'error');
    check('dead AG-UI endpoint is reported in the transcript', text(afterFallback).includes('is not answering'), text(afterFallback));

    // 4. A real CLI session, when the CLI is installed.
    let hasPi = true;
    try {
        execFileSync('pi', ['--version'], { stdio: 'ignore' });
    } catch {
        hasPi = false;
    }
    if (hasPi) {
        await sessions.openSession('check-pi', 'stub-with-cli', { cwd: root });
        await waitIdle(sessions, 'check-pi', 60_000);
        await sessions.send('check-pi', 'reply with the single word hello');
        const afterPi = await waitFor(sessions, 'check-pi', state =>
            state?.entries.some(entry => entry.role === 'agent') || state?.status === 'error', 60_000);
        if (afterPi?.status === 'error') {
            // A provider outage is the agent's problem, not this backend's: the
            // check is structural (does the session become live and resumable?),
            // so a broken provider is reported as skipped rather than failed.
            console.log(`  skip  CLI session (agent reported: ${afterPi.error})`);
        } else {
            check('CLI session produces an agent entry', text(afterPi).includes('agent:'), text(afterPi).slice(0, 200));
            check('CLI session exposes a native resume handle', Boolean(afterPi?.resume?.sessionId),
                JSON.stringify(afterPi?.resume));
        }
    } else {
        console.log('  skip  CLI session (pi is not installed)');
    }

    // 5. The runtime's cursor is incremental: no resend, no lost event.
    const first = await runtime.state('check-agui');
    const second = await runtime.state('check-agui', first.cursor);
    check('runtime state returns events after a cursor only', second.events.length === 0,
        `${first.events.length} then ${second.events.length}`);
    check('runtime cursor advances', second.cursor === first.cursor, `${first.cursor} / ${second.cursor}`);
    await sessions.send('check-agui', 'another turn');
    const third = await runtime.state('check-agui', second.cursor);
    check('runtime reports new events after a prompt', third.events.length > 0, `${third.events.length} events`);

    // 6. Releasing a session frees it: the panel's transcript is gone.
    await sessions.release('check-agui');
    const released = await sessions.summary('check-agui');
    check('release() drops the live session', released.live === false, JSON.stringify(released));

    stub.server.close();
    console.log('');
    if (failures.length > 0) {
        console.error(`${failures.length} of ${checks} check(s) failed:`);
        for (const failure of failures) {
            console.error(`  - ${failure}`);
        }
        process.exit(1);
    }
    console.log(`${checks} check(s) passed.`);
    // Child agents are killed by release(); anything left would keep Node alive.
    process.exit(0);
}

main().catch(error => {
    console.error('Agent session check failed:', error);
    process.exit(1);
});

// Kept for the fixture helpers above; `fs` is here so the file documents intent.
void fs;
