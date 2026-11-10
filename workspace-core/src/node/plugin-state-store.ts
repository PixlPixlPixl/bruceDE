import { promises as fs } from 'fs';
import * as path from 'path';
import { resolveStateFile } from './plugin-paths.js';

export interface PluginStateEntry {
    readonly trusted: boolean;
    readonly enabled: boolean;
}

interface PersistedShape {
    readonly version: 1;
    readonly plugins: Record<string, PluginStateEntry>;
}

/**
 * Durable per-plugin trust and enable flags.
 *
 * Trust is the only gate that matters for security *disclosure*: a third-party
 * plugin never activates until the user accepted the full-system-access
 * warning. Entries for plugins that are no longer discovered are pruned so a
 * replaced folder cannot inherit an old trust decision.
 */
export class PluginStateStore {
    private state = new Map<string, PluginStateEntry>();
    private loaded = false;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly filePath: string = resolveStateFile()) { }

    async load(knownPluginIds: readonly string[]): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        let parsed: unknown;
        try {
            parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        } catch {
            return;
        }
        if (!isPersistedShape(parsed)) {
            return;
        }
        const known = new Set(knownPluginIds);
        for (const [pluginId, entry] of Object.entries(parsed.plugins)) {
            if (known.has(pluginId)) {
                this.state.set(pluginId, { trusted: entry.trusted === true, enabled: entry.enabled === true });
            }
        }
    }

    get(pluginId: string): PluginStateEntry | undefined {
        return this.state.get(pluginId);
    }

    isTrusted(pluginId: string): boolean {
        return this.state.get(pluginId)?.trusted === true;
    }

    isEnabled(pluginId: string): boolean {
        return this.state.get(pluginId)?.enabled === true;
    }

    setTrusted(pluginId: string, trusted: boolean): void {
        this.write(pluginId, { ...(this.state.get(pluginId) ?? { enabled: false }), trusted });
    }

    setEnabled(pluginId: string, enabled: boolean): void {
        this.write(pluginId, { ...(this.state.get(pluginId) ?? { trusted: false }), enabled });
    }

    /** Drops state for plugins that are no longer present. */
    prune(knownPluginIds: readonly string[]): void {
        const known = new Set(knownPluginIds);
        let changed = false;
        for (const pluginId of Array.from(this.state.keys())) {
            if (!known.has(pluginId)) {
                this.state.delete(pluginId);
                changed = true;
            }
        }
        if (changed) {
            void this.persist();
        }
    }

    private write(pluginId: string, entry: PluginStateEntry): void {
        this.state.set(pluginId, entry);
        void this.persist();
    }

    private persist(): Promise<void> {
        const snapshot: PersistedShape = {
            version: 1,
            plugins: Object.fromEntries(this.state.entries())
        };
        this.writeQueue = this.writeQueue.then(async () => {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            const temporary = `${this.filePath}.${process.pid}.tmp`;
            await fs.writeFile(temporary, JSON.stringify(snapshot, undefined, 2), 'utf8');
            await fs.rename(temporary, this.filePath);
        });
        return this.writeQueue.catch(error => {
            // eslint-disable-next-line no-console
            console.error('[plugin-host] Failed to persist plugin state:', error);
        });
    }
}

function isPersistedShape(value: unknown): value is PersistedShape {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.plugins !== 'object' || record.plugins === null) {
        return false;
    }
    for (const entry of Object.values(record.plugins as Record<string, unknown>)) {
        if (typeof entry !== 'object' || entry === null) {
            return false;
        }
        const entryRecord = entry as Record<string, unknown>;
        if (typeof entryRecord.trusted !== 'boolean' || typeof entryRecord.enabled !== 'boolean') {
            return false;
        }
    }
    return true;
}
