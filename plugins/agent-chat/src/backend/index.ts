import type { BackendPluginAPI } from '@icebox/plugin-api';
import { WORKSPACE_SERVICE_IDS } from '@icebox/plugin-api';
import { applyAgUiEvents } from '@icebox/plugin-api';
import type {
    AgentRuntimeService,
    AgentRuntimeState,
    AgentTranscript
} from '@icebox/plugin-api';
import type {
    AgentDescriptor,
    AgentModelInfo,
    AgentSessionOptions,
    AgentSessionSummary,
    AgentState,
    AgentSessionsService,
    ChatEntry
} from '../shared.js';

/**
 * The panel's backend: a facade over the agent runtime.
 *
 * Everything that spawns a process or speaks a protocol lives in
 * `icebox.agent-orchestrator` (see `docs/agent-runtime.md`), so a second chat
 * panel — or a headless consumer — needs no ACP or Pi RPC code of its own. This
 * plugin keeps exactly what belongs to the chat product: the session list
 * surface other plugins consume (`agent.sessions`), and the folding that turns
 * the runtime's AG-UI events into the transcript rows the panel renders.
 *
 * Folding is per session and incremental: the runtime answers with events after
 * a cursor, so a poll transfers only what is new. The cursor is monotonic across
 * the runtime's own log trimming, which is why it — not an array index — is what
 * travels.
 */
export function activate(api: BackendPluginAPI): void {
    // Resolved lazily: `icebox.agent-chat` sorts before `icebox.agent-orchestrator`,
    // so a provider is not guaranteed to exist at activation time. An absent
    // runtime is a state, not a crash: the panel shows "no runtime enabled".
    const runtime = (): AgentRuntimeService | undefined => {
        if (!api.services.has(WORKSPACE_SERVICE_IDS.agentRuntime)) {
            return undefined;
        }
        return api.services.get<AgentRuntimeService>(WORKSPACE_SERVICE_IDS.agentRuntime);
    };

    const requireRuntime = (): AgentRuntimeService => {
        const service = runtime();
        if (!service) {
            throw new Error(
                'No agent runtime is enabled. Enable "Agent Orchestrator" in the plugin manager to chat with agents.'
            );
        }
        return service;
    };

    /** Per session: where the fold is, and what it has produced. */
    const transcripts = new Map<string, { cursor: number; transcript: AgentTranscript }>();

    /**
     * Folds run one at a time per session.
     *
     * The panel polls every 700ms and its interval does not wait for a previous
     * reply, so two requests can read the same cursor. Folding both would apply
     * the same events twice and duplicate every line; serialising keeps one
     * reader per session advancing the cursor it started from.
     */
    const queues = new Map<string, Promise<unknown>>();
    const serial = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
        const previous = queues.get(sessionId) ?? Promise.resolve();
        const next = previous.then(operation, operation);
        queues.set(sessionId, next.catch(() => undefined));
        return next;
    };

    const foldState = (sessionId: string): { cursor: number; transcript: AgentTranscript } => {
        let state = transcripts.get(sessionId);
        if (!state) {
            state = { cursor: 0, transcript: { entries: [], streaming: false } };
            transcripts.set(sessionId, state);
        }
        return state;
    };

    /** Folds whatever the runtime emitted since the last poll. */
    const absorb = (state: AgentRuntimeState): AgentState => {
        const fold = foldState(state.sessionId);
        if (state.events.length > 0) {
            fold.transcript = applyAgUiEvents(fold.transcript, state.events);
            fold.cursor = state.cursor;
        }
        const entries: readonly ChatEntry[] = fold.transcript.entries;
        return {
            agentId: state.agentId,
            status: state.status,
            protocol: state.protocol,
            entries: [...entries],
            error: state.error,
            cwd: state.cwd,
            capabilities: state.capabilities,
            model: state.model,
            usage: state.usage,
            commands: state.commands,
            resume: state.resume,
            revision: state.revision
        };
    };

    /**
     * Current state, folded from the cursor this session has reached.
     *
     * Every path that changes a session ends here rather than consuming the
     * runtime's return value: a mutation answers with the session's *whole* event
     * log, and folding that onto an already-advanced transcript replays every
     * earlier line a second time. Polling and mutating therefore share one reader.
     */
    const readSince = async (sessionId: string): Promise<AgentState> => {
        const folded = foldState(sessionId);
        return absorb(await requireRuntime().state(sessionId, folded.cursor));
    };

    const service: AgentSessionsService = {
        listAgents: async (): Promise<AgentDescriptor[]> => {
            const orchestration = runtime();
            return orchestration ? orchestration.listAgents() : [];
        },

        openSession: (sessionId: string, agentId: string, options?: AgentSessionOptions) =>
            serial(sessionId, async () => {
                // Re-binding starts a fresh conversation, so the fold must forget
                // the transcript it rendered for the previous one; any replayed
                // history then arrives as a full read from cursor 0.
                transcripts.delete(sessionId);
                await requireRuntime().open(sessionId, agentId, options);
                return readSince(sessionId);
            }),

        state: (sessionId: string) => serial(sessionId, async () => {
            if (!runtime()) {
                // No runtime: the panel keeps whatever it already rendered.
                const fold = transcripts.get(sessionId);
                return {
                    agentId: '',
                    status: 'error',
                    error: 'No agent runtime is enabled. Enable "Agent Orchestrator" in the plugin manager.',
                    entries: [...(fold?.transcript.entries ?? [])]
                };
            }
            return readSince(sessionId);
        }),

        summary: async (sessionId): Promise<AgentSessionSummary> => {
            const orchestration = runtime();
            if (!orchestration) {
                return { sessionId, agentId: '', status: 'idle', live: false };
            }
            return orchestration.summary(sessionId);
        },

        listLiveSessions: async (): Promise<AgentSessionSummary[]> => {
            const orchestration = runtime();
            return orchestration ? orchestration.listSessions() : [];
        },

        waitForChange: (sessionId: string, since: number) =>
            // Not serialised, and deliberately so: this call is *supposed* to stay
            // pending, and queueing it behind the fold would deadlock the panel's
            // own updates.
            requireRuntime().waitForChange(sessionId, since),

        send: (sessionId, text) =>
            serial(sessionId, async () => {
                await requireRuntime().send(sessionId, text);
                return readSince(sessionId);
            }),

        interrupt: (sessionId: string) =>
            serial(sessionId, async () => {
                await requireRuntime().interrupt(sessionId);
                return readSince(sessionId);
            }),

        release: (sessionId: string) =>
            serial(sessionId, async () => {
                transcripts.delete(sessionId);
                queues.delete(sessionId);
                await runtime()?.release(sessionId);
            }),

        searchModels: async (sessionId, query, limit): Promise<AgentModelInfo[]> =>
            requireRuntime().searchModels(sessionId, query, limit),

        selectModel: (sessionId, modelKey) =>
            serial(sessionId, async () => {
                await requireRuntime().selectModel(sessionId, modelKey);
                return readSince(sessionId);
            }),

        selectThinking: (sessionId, level) =>
            serial(sessionId, async () => {
                await requireRuntime().selectThinking(sessionId, level);
                return readSince(sessionId);
            }),

        runShell: (sessionId, command) =>
            serial(sessionId, async () => {
                await requireRuntime().runShell(sessionId, command);
                return readSince(sessionId);
            })
    };

    api.services.provide(WORKSPACE_SERVICE_IDS.agentSessions, service);
}
