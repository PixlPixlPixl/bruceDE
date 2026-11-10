import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { PLUGIN_HOST_PATH } from '../common/plugin-host-protocol.js';
import { PluginHostBackendService } from './plugin-host-backend-service.js';

/**
 * Exposes the plugin host to the renderer over Theia's existing RPC channel.
 *
 * The connection container inherits the backend main container as its parent,
 * so binding the singleton service in the main container is enough for
 * `bindBackendService` to resolve it per connection. Discovery state and trust
 * decisions therefore stay on one shared instance.
 */
const pluginHostConnectionModule = ConnectionContainerModule.create(({ bindBackendService }) => {
    bindBackendService(PLUGIN_HOST_PATH, PluginHostBackendService);
});

export default new ContainerModule(bind => {
    bind(PluginHostBackendService).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(PluginHostBackendService);
    bind(ConnectionContainerModule).toConstantValue(pluginHostConnectionModule);
});
