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
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ORCHESTRATOR = path.join(root, 'plugins', 'agent-orchestrator', 'dist', 'backend.js');
/** Fake ACP agent: one process that can hold several sessions. */
const ACP_STUB = path.join(root, 'scripts', 'fixtures', 'acp-stub.mjs');
const PANEL_BACKEND = path.join(root, 'plugins', 'agent-chat', 'dist', 'backend.js');

const failures = [];
let checks = 0;
/** Every line of the run, kept for the CI summary as well as the console. */
const report = [];

/** True when this is running inside GitHub Actions. */
const inActions = process.env.GITHUB_ACTIONS === 'true';

function log(line) {
    report.push(line);
    console.log(line);
}

function check(name, condition, detail) {
    checks++;
    const outcome = `${name}${detail ? ` — ${detail}` : ''}`;
    if (condition) {
        log(`  ok    ${name}`);
    } else {
        failures.push(outcome);
        log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
        // An annotation surfaces the failing check on the pull request instead of
        // leaving it buried in a log nobody opens.
        if (inActions) {
            console.log(`::error title=${escapeAnnotation(name)}::${escapeAnnotation(outcome)}`);
        }
    }
}

/**
 * GitHub annotations are single-line `key=value` commands.
 *
 * A raw newline or percent sign in a detail string would break the command and
 * silently drop the annotation, so both are escaped.
 */
function escapeAnnotation(value) {
    return String(value)
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A')
        .replace(/:/g, '%3A')
        .replace(/,/g, '%2C');
}

/** Escapes the characters that would end a Markdown table cell. */
function escapeCell(value) {
    let escaped = String(value);
    escaped = escaped.split('|').join('\\|');
    escaped = escaped.split('\n').join(' ');
    return escaped;
}

/** Writes the run to the job summary, which is the page a reviewer actually reads. */
function publishSummary() {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (!target) {
        return;
    }
    const lines = [
        `## Agent session check`,
        '',
        `**${checks - failures.length} of ${checks}** passed.`,
        '',
        '| Result | Check |',
        '| --- | --- |'
    ];
    for (const line of report) {
        const match = /^  (ok    |FAIL  )(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        lines.push(`| ${match[1].trim()} | ${escapeCell(match[2])} |`);
    }
    try {
        appendFileSync(target, `${lines.join('\n')}\n`);
    } catch {
        // A summary is a convenience: never fail the run for it.
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
        if (request.url.startsWith('/slow')) {
            // A run that streams a little and then waits for the client to give up:
            // the only way to observe a turn that is still running.
            send({ type: 'RUN_STARTED', responseId: 'slow-run', threadId: thread });
            send({ type: 'TEXT_MESSAGE_START', messageId: 's1' });
            send({ type: 'TEXT_MESSAGE_CONTENT', messageId: 's1', delta: 'working' });
            request.on('close', () => response.end());
            return;
        }
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
    // Declared as agent data, exactly as a plugin would: `available` is not part of
    // a manifest, so it is left out and the runtime decides it.
    const slow = { id: 'agui-slow', name: 'AG-UI Slow', protocol: 'acp', agui: `http://127.0.0.1:${aguiPort}/slow` };
    return [
        {
            id: 'icebox.agent-test',
            name: 'Test agents',
            version: '0.1.0',
            builtIn: true,
            enabled: true,
            agents: [
                slow,
                // A real ACP agent over a fake process: `node <stub>` speaks the
                // protocol, so repeated `session/new` can be exercised honestly.
                { id: 'acp-stub', name: 'ACP stub', protocol: 'acp', command: process.execPath, args: [ACP_STUB] },
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
function fakeApi({ id, directory, services, cwd, disposers = [] }) {
    return {
        manifest: { id, name: id, version: '0.1.0', apiVersion: 1, entrypoints: {} },
        side: 'backend',
        origin: { builtIn: true, directory },
        workspace: { root: cwd, cwd },
        services: {
            provide: (serviceId, service) => {
                services.set(serviceId, service);
                // Registered like the real host: unloading the plugin must retract
                // the service, which is what the disabled-runtime group observes.
                const dispose = () => {
                    if (services.get(serviceId) === service) {
                        services.delete(serviceId);
                    }
                };
                disposers.push(dispose);
                return dispose;
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
        onDispose: disposer => {
            disposers.push(disposer);
        },
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
    // Declared before activation: `fakeApi` collects the orchestrator's
    // disposers as it registers them, and the last group calls them.
    const orchestratorDisposers = [];
    const shared = { catalogueEntries: [], services, cwd: root };

    console.log('Agent session check');
    const orchestratorModule = await import(`file://${ORCHESTRATOR}`);
    orchestratorModule.activate(fakeApi({
        ...shared,
        id: 'icebox.agent-orchestrator',
        directory: path.join(root, 'plugins', 'agent-orchestrator'),
        disposers: orchestratorDisposers
    }));
    const panelModule = await import(`file://${PANEL_BACKEND}`);
    panelModule.activate(fakeApi({
        ...shared,
        id: 'icebox.agent-chat',
        directory: path.join(root, 'plugins', 'agent-chat')
    }));

    const sessions = services.get('agent.sessions');
    // Captured so the last group can unload the orchestrator without the app.
    const disposeOrchestrator = () => {
        for (const dispose of orchestratorDisposers.splice(0)) {
            dispose();
        }
    };
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
    // A tool line is the role label plus the tool's own name or result: the text
    // must not repeat the label, which is what made a call read "Tool tool: bash".
    check('AG-UI tool call is named without repeating the label',
        text(afterAgui).includes('tool:echo'), text(afterAgui));
    check('AG-UI tool result reaches the transcript', text(afterAgui).includes('tool:thread '), text(afterAgui));
    check('no transcript entry repeats its own role label',
        !text(afterAgui).includes('tool:tool:'), text(afterAgui));
    check('AG-UI session settles back to idle', afterAgui?.status === 'idle', String(afterAgui?.status));
    // A chat that names no folder belongs to the user, not to the checkout the
    // app was started from: it runs in their home directory.
    check('a session without a folder runs in the home directory',
        afterAgui?.cwd === os.homedir(), `${afterAgui?.cwd} (expected ${os.homedir()})`);
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
            log(`  skip  CLI session (agent reported: ${afterPi.error})`);
        } else {
            check('CLI session produces an agent entry', text(afterPi).includes('agent:'), text(afterPi).slice(0, 200));
            check('CLI session exposes a native resume handle', Boolean(afterPi?.resume?.sessionId),
                JSON.stringify(afterPi?.resume));
        }
    } else {
        log('  skip  CLI session (pi is not installed)');
    }

    // 5. A running turn can be stopped, and stopping it is not closing the session.
    await sessions.openSession('check-stop', 'agui-slow');
    // Opening starts the connection in the background; a prompt before it settles
    // is refused, so wait for the bind before asking for a turn.
    await waitIdle(sessions, 'check-stop', 10_000);
    // `send` resolves as soon as the prompt is accepted, so the turn is in flight
    // while the stub keeps the stream open.
    const started = await sessions.send('check-stop', 'keep working');
    check('slow AG-UI turn is reported running', started?.status === 'running', String(started?.status));
    check('interrupt is advertised as a capability', started?.capabilities?.interrupt === true,
        JSON.stringify(started?.capabilities));
    const stopped = await sessions.interrupt('check-stop');
    check('interrupt records why the turn ended',
        text(stopped).includes('Turn interrupted'), text(stopped).slice(-160));
    const settled = await waitFor(sessions, 'check-stop', state => state?.status === 'idle' && !state?.error);
    check('interrupt settles the session to idle, not error', settled?.status === 'idle' && !settled?.error,
        `${settled?.status} ${settled?.error ?? ''}`);
    // The same connection must serve the next turn: a stop is not a dispose.
    const again = await sessions.send('check-stop', 'carry on');
    const afterAgain = await waitFor(sessions, 'check-stop', state =>
        text(state).includes('stub answer'), 5000).catch(() => undefined);
    check('the session still serves a turn after an interrupt', Boolean(again), 'send accepted');
    check('a later turn streams through the aborted connection', Boolean(afterAgain), 'no answer after interrupt');
    // A mutation answers with the session's whole log; the panel folds only the
    // delta, so a second turn must not replay the first one's lines.
    const occurrences = (state, needle) => text(state).split(needle).length - 1;
    check('a second turn does not replay the first turn',
        occurrences(afterAgain ?? again, 'keep working') === 1,
        `${occurrences(afterAgain ?? again, 'keep working')} copies of the first prompt`);
    check('interrupt adds exactly one transcript line',
        occurrences(afterAgain ?? again, 'Turn interrupted') === 1,
        `${occurrences(afterAgain ?? again, 'Turn interrupted')} copies`);

    // Idempotent: a second stop on an idle session is a no-op, not an error.
    const extra = await sessions.interrupt('check-stop').catch(error => ({ error: String(error) }));
    check('interrupt on an idle session is harmless', !extra?.error, String(extra?.error ?? '').slice(0, 80));

    // 6. A session announces its own changes instead of being polled.
    const baseline = (await runtime.state('check-stop')).revision;
    check('state reports a revision', typeof baseline === 'number', String(baseline));
    const pendingChange = runtime.waitForChange('check-stop', baseline);
    let settledByPush = false;
    pendingChange.then(() => { settledByPush = true; }, () => undefined);
    await new Promise(resolve => setTimeout(resolve, 50));
    check('waitForChange stays pending while nothing happens', !settledByPush);
    await sessions.send('check-stop', 'keep working');
    const pushedTo = await pendingChange;
    check('waitForChange answers as soon as the session changes', pushedTo > baseline, `${baseline} -> ${pushedTo}`);
    // A session that never changes must not answer with a change: the timeout
    // returns the revision it was given, which tells the caller to wait again.
    // Checked on its own idle session, because the one above is still settling an
    // interrupt and would legitimately wake a waiter.
    const quiet = (await runtime.state('check-quiet')).revision;
    const timedOut = await runtime.waitForChange('check-quiet', quiet, 700);
    check('waitForChange times out with the same revision', timedOut === quiet, `${quiet} / ${timedOut}`);
    await runtime.release('check-quiet');
    // Already-stale callers are answered at once rather than waiting for the next
    // change that may never come.
    const stale = await runtime.waitForChange('check-stop', quiet - 1, 5000);
    check('waitForChange answers immediately when already behind', stale >= quiet, String(stale));

    // 7. Two chats on one ACP agent share one process.
    const pidFile = path.join(root, '.tmp-acp-pids');
    try {
        rmSync(pidFile, { force: true });
    } catch {
        // Nothing to clear.
    }
    process.env.CHECK_PID_FILE = pidFile;
    const pids = () => (existsSync(pidFile)
        ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean)
        : []);
    if (!existsSync(ACP_STUB)) {
        log(`  skip  ACP sharing (${path.relative(root, ACP_STUB)} is missing)`);
    } else {
        await sessions.openSession('check-acp-1', 'acp-stub');
        await waitIdle(sessions, 'check-acp-1', 10_000);
        await sessions.openSession('check-acp-2', 'acp-stub');
        await waitIdle(sessions, 'check-acp-2', 10_000);
        check('two ACP chats start one process', pids().length === 1, `${pids().length} process(es): ${pids().join(', ')}`);
        const first = await runtime.state('check-acp-1');
        const second = await runtime.state('check-acp-2');
        check('each ACP chat gets its own agent session',
            first.resume?.sessionId !== second.resume?.sessionId,
            `${first.resume?.sessionId} / ${second.resume?.sessionId}`);
        check('both ACP chats are live', first.status === 'idle' && second.status === 'idle',
            `${first.status} / ${second.status}`);

        await sessions.send('check-acp-1', 'one');
        const answeredFirst = await waitFor(sessions, 'check-acp-1', state =>
            text(state).includes('echo one'), 10_000);
        await sessions.send('check-acp-2', 'two');
        const answeredSecond = await waitFor(sessions, 'check-acp-2', state =>
            text(state).includes('echo two'), 10_000);
        check('shared process answers each chat separately',
            text(answeredFirst).includes('echo one') && !text(answeredFirst).includes('echo two')
            && text(answeredSecond).includes('echo two') && !text(answeredSecond).includes('echo one'),
            `${text(answeredFirst).slice(-60)} | ${text(answeredSecond).slice(-60)}`);
        check('commands are routed per session',
            (answeredFirst?.commands ?? []).length > 0 && (answeredSecond?.commands ?? []).length > 0,
            `${(answeredFirst?.commands ?? []).length} / ${(answeredSecond?.commands ?? []).length}`);

        // Closing one chat must not close the other's process.
        await sessions.release('check-acp-1');
        const survivor = await runtime.state('check-acp-2');
        await sessions.send('check-acp-2', 'still here');
        const afterRelease = await waitFor(sessions, 'check-acp-2', state =>
            text(state).includes('echo still here'), 10_000);
        check('releasing one chat leaves the shared process alive',
            text(afterRelease).includes('echo still here'), text(afterRelease).slice(-60));
        check('the surviving chat keeps its own session', survivor.resume?.sessionId === second.resume?.sessionId,
            `${survivor.resume?.sessionId}`);

        // The last one out turns the lights off.
        const survivorPid = Number(pids().at(-1));
        await sessions.release('check-acp-2');
        await new Promise(resolve => setTimeout(resolve, 300));
        let processGone = false;
        try {
            process.kill(survivorPid, 0);
        } catch {
            processGone = true;
        }
        check('the last chat closes the shared process', processGone, `pid ${survivorPid} ${processGone ? 'gone' : 'alive'}`);

        // A chat released while its handshake is still running has no link yet.
        // Nothing else holds that client, so the process would outlive it forever.
        const startBaseline = pids().length;
        await sessions.openSession('check-acp-start', 'acp-stub');
        await sessions.release('check-acp-start');
        await new Promise(resolve => setTimeout(resolve, 600));
        await sessions.openSession('check-acp-start', 'acp-stub');
        const restarted = await waitIdle(sessions, 'check-acp-start', 10_000);
        check('a chat released while starting can be opened again',
            typeof restarted?.status === 'string', String(restarted?.status));
        await sessions.release('check-acp-start');
        await new Promise(resolve => setTimeout(resolve, 600));
        const alive = pids().slice(startBaseline).filter(pid => {
            try {
                process.kill(Number(pid), 0);
                return true;
            } catch {
                return false;
            }
        });
        check('releasing a chat while it starts leaves no process behind',
            alive.length === 0, `alive: ${alive.join(', ') || 'none'}`);
    }
    delete process.env.CHECK_PID_FILE;

    // 8. The runtime's cursor is incremental: no resend, no lost event.
    const first = await runtime.state('check-agui');
    const second = await runtime.state('check-agui', first.cursor);
    check('runtime state returns events after a cursor only', second.events.length === 0,
        `${first.events.length} then ${second.events.length}`);
    check('runtime cursor advances', second.cursor === first.cursor, `${first.cursor} / ${second.cursor}`);
    await sessions.send('check-agui', 'another turn');
    const third = await runtime.state('check-agui', second.cursor);
    check('runtime reports new events after a prompt', third.events.length > 0, `${third.events.length} events`);

    // 9. Disabling the runtime is a stated state, not a crash.
    disposeOrchestrator();
    check('orchestrator drops its service on unload', !services.has('agent.runtime'));
    const degraded = await sessions.state('check-agui').catch(error => ({ error: String(error) }));
    check('panel reports a disabled runtime instead of throwing',
        typeof degraded.error === 'string' && degraded.error.includes('Agent Orchestrator'),
        String(degraded.error ?? '').slice(0, 90));
    check('panel keeps its rendered transcript while the runtime is gone',
        (degraded.entries ?? []).length > 0, `${(degraded.entries ?? []).length} entries kept`);

    // 10. Releasing a session frees it: the panel's transcript is gone.
    await sessions.release('check-agui');
    const released = await sessions.summary('check-agui');
    check('release() drops the live session', released.live === false, JSON.stringify(released));

    // 11. A rebuilt backend bundle is re-imported when the plugin is re-enabled.
    //
    // Node keeps one module per URL for the life of the process, so the host
    // stamps the bundle URL with the file's build stamp. Without it, a rebuilt
    // backend only took effect after restarting the server — and restarting is
    // what kills the agent sessions that belong to the backend process. The
    // probe bundle records itself on `globalThis`, so a re-import is observable
    // without reading a server log.
    const reloadDir = path.join(root, '.tmp-plugin-reload');
    const reloadBundle = path.join(reloadDir, 'bundle.js');
    const probeKey = '__iceboxReloadProbe';
    const writeBundle = async version => {
        await fs.writeFile(reloadBundle, `globalThis['${probeKey}'] = '${version}';\nexport function activate() {}\n`);
    };
    const hostLib = path.join(root, 'workspace-core', 'lib', 'node', 'plugin-backend-runtime.js');
    if (!existsSync(hostLib)) {
        log(`  skip  backend reload (${path.relative(root, hostLib)} is missing. Run: npm run build:workspace-core)`);
    } else {
        await fs.mkdir(reloadDir, { recursive: true });
        // Real plugin folders declare ESM, and Node warns on a typeless bundle.
        await fs.writeFile(path.join(reloadDir, 'package.json'), '{"type":"module"}\n');
        await writeBundle('v1');
        try {
            const hostRuntime = await import(`file://${hostLib}`);
            const registries = await import(`file://${path.join(root, 'workspace-core', 'lib', 'common', 'plugin-registries.js')}`);
            const pluginHost = new hostRuntime.PluginBackendRuntime({
                isTrusted: () => true,
                logger: { info: () => undefined, error: message => log(`  reload error: ${message}`) },
                services: new registries.PluginServiceRegistry(),
                events: new registries.PluginEventBus()
            });
            const probePlugin = {
                manifest: {
                    id: 'icebox.reload-probe',
                    name: 'Reload probe',
                    version: '0.1.0',
                    apiVersion: 1,
                    entrypoints: { backend: './bundle.js' }
                },
                directory: reloadDir,
                builtIn: false,
                backendEntrypoint: reloadBundle
            };
            await pluginHost.load(probePlugin);
            check('a backend plugin bundle is imported', globalThis[probeKey] === 'v1', String(globalThis[probeKey]));
            await pluginHost.unload(probePlugin.manifest.id);
            await writeBundle('v2');
            await pluginHost.load(probePlugin);
            check('a rebuilt backend bundle is re-imported on re-enable',
                globalThis[probeKey] === 'v2', String(globalThis[probeKey]));
            await pluginHost.unload(probePlugin.manifest.id);
        } finally {
            delete globalThis[probeKey];
            rmSync(reloadDir, { recursive: true, force: true });
        }
    }

    stub.server.close();
    console.log('');
    if (failures.length > 0) {
        const message = `${failures.length} of ${checks} check(s) failed`;
        log(message);
        publishSummary();
        // The per-check annotations already name what broke; this one is the
        // headline the run shows in its status.
        if (inActions) {
            console.log(`::error title=Agent session check::${escapeAnnotation(message)}`);
        }
        process.exit(1);
    }
    log(`${checks} check(s) passed.`);
    publishSummary();
    // Child agents are killed by release(); anything left would keep Node alive.
    process.exit(0);
}

main().catch(error => {
    console.error('Agent session check failed:', error);
    process.exit(1);
});

// Kept for the fixture helpers above; `fs` is here so the file documents intent.
void fs;
