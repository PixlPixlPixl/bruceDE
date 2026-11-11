import type { PluginDisposer } from '@icebox/plugin-api';

/**
 * Runs registered disposers in reverse order, exactly once, even when one of
 * them throws. Cordis already disposes what it owns; this bag covers disposers
 * a plugin registers imperatively through `api.onDispose`.
 */
export class DisposerBag {
    private readonly disposers: PluginDisposer[] = [];
    private disposal: Promise<void> | undefined;

    constructor(private readonly onError: (error: unknown) => void = () => undefined) { }

    get size(): number {
        return this.disposers.length;
    }

    add(disposer: PluginDisposer): PluginDisposer {
        if (this.disposal) {
            throw new Error('Cannot register a disposer after the plugin was disposed.');
        }
        this.disposers.push(disposer);
        return disposer;
    }

    /**
     * Removes a previously added disposer without running it (idempotent).
     */
    remove(disposer: PluginDisposer): void {
        const index = this.disposers.indexOf(disposer);
        if (index !== -1) {
            this.disposers.splice(index, 1);
        }
    }

    /**
     * Runs every disposer in reverse registration order. Failures are reported
     * but do not prevent the remaining disposers from running.
     */
    disposeAll(): Promise<void> {
        if (!this.disposal) {
            this.disposal = (async () => {
                const pending = this.disposers.splice(0).reverse();
                for (const disposer of pending) {
                    try {
                        await disposer();
                    } catch (error) {
                        this.onError(error);
                    }
                }
            })();
        }
        return this.disposal;
    }

    /** Alias kept for call sites that read better as a noun. */
    get dispose(): PluginDisposer {
        return () => this.disposeAll();
    }
}

/**
 * Collects the return value of a plugin `activate` function into a disposer.
 * Plugins may return nothing, a single disposer, or a promise of either.
 */
export function toDisposer(value: void | PluginDisposer): PluginDisposer | undefined {
    return typeof value === 'function' ? value : undefined;
}
