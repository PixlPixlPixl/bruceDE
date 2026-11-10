import { inject, injectable, named } from '@theia/core/shared/inversify';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import type { Widget } from '@lumino/widgets';
import { HOST_PANEL_CAPABILITIES } from '@brucede/plugin-api';

/**
 * Shape a capability id must have: lower-case, dot-separated, at least one dot
 * (`brucede.terminal`). Deliberately *not* a module path or a class name — the
 * id names a host capability, not an implementation.
 */
export const HOST_PANEL_CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

/** Everything a host panel factory is told when it builds one panel. */
export interface HostPanelCreateRequest {
    /** The capability that is being created, e.g. `brucede.terminal`. */
    readonly capabilityId: string;
    /** Stable instance id, used for titles and per-instance bookkeeping. */
    readonly instanceId: string;
    /** JSON-serializable options the plugin passed to `registerHostPanel`. */
    readonly options?: Readonly<Record<string, unknown>>;
}

/**
 * DI token for {@link HostPanelFactory} contributions.
 *
 * Theia's convention: a `unique symbol` value paired with the interface type of
 * the same name, so `bind(HostPanelFactory).toService(...)` and
 * `@named(HostPanelFactory)` refer to one contribution point.
 */
export const HostPanelFactory: unique symbol = Symbol('HostPanelFactory');

/**
 * A host-owned implementation of one panel capability.
 *
 * Factories are contributed host-side (Inversify `HostPanelFactory` bindings).
 * They may use the host's DI freely; the plugin only ever names the capability.
 */
export interface HostPanelFactory {
    /** Stable capability id. Must satisfy {@link HOST_PANEL_CAPABILITY_PATTERN}. */
    readonly capabilityId: string;
    /** Human-readable name used in diagnostics. */
    readonly label: string;
    createPanel(request: HostPanelCreateRequest): Widget | Promise<Widget>;
}

/**
 * Curated registry of host panel capabilities.
 *
 * This is the only way a plugin can get native host UI. It never exposes the
 * container, `WidgetManager`, `TerminalService` or raw widget instances, and the
 * catalog stays deliberately small: capabilities are added host-side as real
 * needs appear, not speculatively.
 */
@injectable()
export class HostPanelFactoryRegistry {
    protected readonly factories = new Map<string, HostPanelFactory>();
    protected collected = false;

    constructor(
        @inject(ContributionProvider)
        @named(HostPanelFactory)
        protected readonly contributions: ContributionProvider<HostPanelFactory>
    ) { }

    /** True when a capability with this id is currently available. */
    has(capabilityId: string): boolean {
        return this.collect().has(capabilityId);
    }

    /** Capabilities currently available, for diagnostics and the plugin manager. */
    list(): readonly { readonly capabilityId: string; readonly label: string }[] {
        return Array.from(this.collect().values(), factory => ({
            capabilityId: factory.capabilityId,
            label: factory.label
        })).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
    }

    /**
     * Late-bound registration for host extensions that are not wired through
     * contribution bindings. Returns a disposer.
     */
    register(factory: HostPanelFactory): () => void {
        if (!HOST_PANEL_CAPABILITY_PATTERN.test(factory.capabilityId)) {
            throw new Error(
                `Host panel capability "${factory.capabilityId}" must be a lower-case dot-separated id such as "${HOST_PANEL_CAPABILITIES.terminal}".`
            );
        }
        if (this.has(factory.capabilityId)) {
            throw new Error(`Host panel capability already registered: ${factory.capabilityId}`);
        }
        this.factories.set(factory.capabilityId, factory);
        return () => {
            if (this.factories.get(factory.capabilityId) === factory) {
                this.factories.delete(factory.capabilityId);
            }
        };
    }

    /** Builds one panel through the capability. Throws for an unknown id. */
    async create(capabilityId: string, request: HostPanelCreateRequest): Promise<Widget> {
        const factory = this.collect().get(capabilityId);
        if (!factory) {
            throw new Error(
                `Host panel capability "${capabilityId}" is not available in this build. `
                + `Available: ${this.list().map(entry => entry.capabilityId).join(', ') || 'none'}.`
            );
        }
        return factory.createPanel(request);
    }

    /** Collects contributed factories on first use. */
    protected collect(): ReadonlyMap<string, HostPanelFactory> {
        if (!this.collected) {
            this.collected = true;
            for (const factory of this.contributions.getContributions()) {
                if (!HOST_PANEL_CAPABILITY_PATTERN.test(factory.capabilityId)) {
                    // A malformed id is a host bug; refuse it loudly instead of
                    // letting plugins adopt an unreachable capability.
                    // eslint-disable-next-line no-console
                    console.error(
                        `[workspace] Ignoring host panel factory with invalid capability id "${factory.capabilityId}".`
                    );
                    continue;
                }
                if (this.factories.has(factory.capabilityId)) {
                    // eslint-disable-next-line no-console
                    console.error(
                        `[workspace] Duplicate host panel capability "${factory.capabilityId}"; keeping the first.`
                    );
                    continue;
                }
                this.factories.set(factory.capabilityId, factory);
            }
        }
        return this.factories;
    }
}
