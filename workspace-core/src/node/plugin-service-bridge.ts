import { inject, injectable } from '@theia/core/shared/inversify';
import { PluginHostBackendService } from './plugin-host-backend-service.js';
import type { PluginServiceBridge } from '../common/plugin-host-protocol.js';

/**
 * Backend half of the renderer → backend service bridge.
 *
 * It resolves every call through the *shared* backend service registry, so a
 * renderer panel can call a service a backend plugin provided without the two
 * plugins knowing about each other. Results and arguments cross Theia's normal
 * RPC channel and must therefore be JSON-serializable.
 */
@injectable()
export class PluginServiceBridgeImpl implements PluginServiceBridge {
    constructor(
        @inject(PluginHostBackendService) protected readonly host: PluginHostBackendService
    ) { }

    async listServices(): Promise<readonly string[]> {
        return this.host.backendServiceIds();
    }

    async invoke(serviceId: string, method: string, args: readonly unknown[]): Promise<unknown> {
        if (!this.host.backendServices.has(serviceId)) {
            throw new Error(
                `Service "${serviceId}" is not provided by a backend plugin. `
                + 'Services provided in the renderer are reachable through api.services.get.'
            );
        }
        const service = this.host.backendServices.get<Record<string, unknown>>(serviceId);
        const candidate = service[method];
        if (candidate === undefined) {
            throw new Error(`Service "${serviceId}" has no member "${method}".`);
        }
        if (typeof candidate !== 'function') {
            return candidate;
        }
        // SAFETY: `method` was looked up on the registered service object and
        // checked to be a function; the service implementation owns the
        // argument contract, which is why the bridge only forwards JSON data.
        const call = candidate as (...callArgs: unknown[]) => unknown;
        return await call.apply(service, [...args]);
    }
}
