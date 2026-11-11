import type { PluginDisposer } from '@icebox/plugin-api';

/**
 * Owner-keyed registries shared by every plugin on one side of the RPC boundary.
 *
 * These classes are deliberately framework-free: the renderer and the Node
 * backend both use them so a plugin sees the same service/event semantics on
 * both sides. They must not import Theia, Lumino, React or Node APIs.
 *
 * Every entry is recorded against the plugin that created it, so unloading that
 * plugin removes exactly its own contributions and never a service that another
 * plugin still depends on.
 */

interface OwnedService {
    readonly owner: string;
    readonly value: unknown;
}

export class PluginServiceRegistry {
    private readonly services = new Map<string, OwnedService>();

    provide<T>(owner: string, serviceId: string, service: T): PluginDisposer {
        if (this.services.has(serviceId)) {
            throw new Error(`Service already provided: ${serviceId}`);
        }
        this.services.set(serviceId, { owner, value: service });
        return () => {
            if (this.services.get(serviceId)?.owner === owner) {
                this.services.delete(serviceId);
            }
        };
    }

    get<T>(serviceId: string): T {
        const entry = this.services.get(serviceId);
        if (!entry) {
            throw new Error(`Unknown service: ${serviceId}`);
        }
        return entry.value as T;
    }

    has(serviceId: string): boolean {
        return this.services.has(serviceId);
    }

    /** Service ids provided by one owner. */
    idsByOwner(owner: string): readonly string[] {
        return Array.from(this.services.entries())
            .filter(([, entry]) => entry.owner === owner)
            .map(([serviceId]) => serviceId);
    }

    /** Every service id currently resolvable in this registry. */
    ids(): readonly string[] {
        return Array.from(this.services.keys());
    }

    /** Removes every service a plugin provided. */
    removeByOwner(owner: string): void {
        for (const [serviceId, entry] of Array.from(this.services.entries())) {
            if (entry.owner === owner) {
                this.services.delete(serviceId);
            }
        }
    }
}

interface EventListener {
    readonly owner: string;
    readonly listener: (payload: unknown) => void | Promise<void>;
}

export class PluginEventBus {
    private readonly listeners = new Map<string, Set<EventListener>>();

    on<T>(owner: string, eventName: string, listener: (payload: T) => void | Promise<void>): PluginDisposer {
        const entry: EventListener = {
            owner,
            listener: listener as (payload: unknown) => void | Promise<void>
        };
        let set = this.listeners.get(eventName);
        if (!set) {
            set = new Set();
            this.listeners.set(eventName, set);
        }
        set.add(entry);
        return () => {
            const current = this.listeners.get(eventName);
            current?.delete(entry);
            if (current && current.size === 0) {
                this.listeners.delete(eventName);
            }
        };
    }

    /**
     * Notifies every listener on this side. A throwing listener is reported and
     * does not stop the remaining ones.
     */
    emit<T>(eventName: string, payload: T): void {
        for (const { listener } of this.listeners.get(eventName) ?? []) {
            try {
                void listener(payload);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error(`[plugin-host] Listener for "${eventName}" threw:`, error);
            }
        }
    }

    /** Removes every listener a plugin registered. */
    removeByOwner(owner: string): void {
        for (const [eventName, set] of Array.from(this.listeners.entries())) {
            for (const entry of Array.from(set)) {
                if (entry.owner === owner) {
                    set.delete(entry);
                }
            }
            if (set.size === 0) {
                this.listeners.delete(eventName);
            }
        }
    }
}
