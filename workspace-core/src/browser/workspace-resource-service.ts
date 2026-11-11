import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import {
    ICEBOX_WORKSPACE_PLUGIN_ID,
    WORKSPACE_SERVICE_IDS,
    type PluginDisposer,
    type ResourceKind,
    type ResourceSelection,
    type ResourceStat,
    type ResourceUri,
    type WorkspaceResourcesService
} from '@icebox/plugin-api';
import { PluginServiceRegistry } from '../common/plugin-registries.js';

/**
 * The host's resource identity and metadata service.
 *
 * Resource URIs are Theia URIs, so the same string identifies the same resource
 * in the renderer and in the backend. Plugins must obtain URIs here instead of
 * building `file://` strings themselves — that is what keeps File Browser and
 * Git talking about the same file.
 */
@injectable()
export class WorkspaceResourceService implements WorkspaceResourcesService {
    constructor(
        @inject(FileService) protected readonly files: FileService,
        @inject(PluginServiceRegistry) protected readonly services: PluginServiceRegistry
    ) { }

    /** Publishes the service under the host's owner id. */
    install(): PluginDisposer {
        return this.services.provide(ICEBOX_WORKSPACE_PLUGIN_ID, WORKSPACE_SERVICE_IDS.resources, this);
    }

    fromPath(absolutePath: string): ResourceUri {
        return URI.fromFilePath(absolutePath).toString();
    }

    async stat(uri: ResourceUri): Promise<ResourceStat | undefined> {
        try {
            const stat = await this.files.resolve(new URI(uri), { resolveMetadata: false });
            return toResourceStat(stat);
        } catch {
            return undefined;
        }
    }

    async list(uri: ResourceUri): Promise<readonly ResourceStat[]> {
        try {
            const stat = await this.files.resolve(new URI(uri), { resolveMetadata: false });
            return (stat.children ?? []).map(toResourceStat);
        } catch {
            return [];
        }
    }
}

/** Maps Theia file metadata onto the plugin-facing shape. */
function toResourceStat(stat: FileStat): ResourceStat {
    const base: { uri: ResourceUri; name: string; kind: ResourceKind; children?: readonly ResourceStat[] } = {
        uri: stat.resource.toString(),
        name: stat.name || stat.resource.path.base,
        kind: stat.isDirectory ? 'directory' : stat.isFile ? 'file' : 'unknown'
    };
    if (stat.children) {
        return { ...base, children: stat.children.map(toResourceStat) };
    }
    return base;
}

/** Builds a selection for a whole resource, the common single-file case. */
export function wholeResourceSelection(uri: ResourceUri): ResourceSelection {
    return {
        uri,
        ranges: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }]
    };
}
