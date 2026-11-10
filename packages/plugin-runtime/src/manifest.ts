import { BRUCE_PLUGIN_API_VERSION, type PluginManifest } from '@brucede/plugin-api';

/** Pattern for a globally unique, namespaced plugin id, e.g. `bruce.terminal`. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** API versions this runtime can host. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [BRUCE_PLUGIN_API_VERSION];

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class PluginManifestError extends Error {
    constructor(message: string, readonly manifestPath?: string) {
        super(manifestPath ? `${manifestPath}: ${message}` : message);
        this.name = 'PluginManifestError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, context: string): string {
    const value = source[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new PluginManifestError(`"${key}" must be a non-empty string (${context}).`);
    }
    return value.trim();
}

function optionalString(source: Record<string, unknown>, key: string, context: string): string | undefined {
    const value = source[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new PluginManifestError(`"${key}" must be a string when present (${context}).`);
    }
    return value.trim();
}

/**
 * Rejects entrypoints that are absolute, escape the plugin folder, or are empty.
 * The value is interpreted relative to the plugin directory by the host loader.
 */
function validateEntrypointPath(value: string, side: 'frontend' | 'backend'): string {
    const normalized = value.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
        throw new PluginManifestError(`"entrypoints.${side}" must be relative to the plugin folder.`);
    }
    const segments = normalized.split('/');
    if (segments.some(segment => segment === '..')) {
        throw new PluginManifestError(`"entrypoints.${side}" must not escape the plugin folder.`);
    }
    if (!normalized.endsWith('.js') && !normalized.endsWith('.mjs')) {
        throw new PluginManifestError(`"entrypoints.${side}" must reference a JavaScript ESM bundle.`);
    }
    return normalized;
}

function validatePanels(value: unknown, context: string): PluginManifest['contributes'] extends undefined ? never : { id: string; title: string; icon?: string }[] {
    if (!Array.isArray(value)) {
        throw new PluginManifestError(`"contributes.panels" must be an array (${context}).`);
    }
    const seen = new Set<string>();
    return value.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new PluginManifestError(`"contributes.panels[${index}]" must be an object (${context}).`);
        }
        const id = requireString(entry, 'id', context);
        if (seen.has(id)) {
            throw new PluginManifestError(`Duplicate contributed panel id "${id}" (${context}).`);
        }
        seen.add(id);
        return { id, title: requireString(entry, 'title', context), icon: optionalString(entry, 'icon', context) };
    });
}

function validateCommands(value: unknown, context: string): { id: string; title: string }[] {
    if (!Array.isArray(value)) {
        throw new PluginManifestError(`"contributes.commands" must be an array (${context}).`);
    }
    const seen = new Set<string>();
    return value.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new PluginManifestError(`"contributes.commands[${index}]" must be an object (${context}).`);
        }
        const id = requireString(entry, 'id', context);
        if (seen.has(id)) {
            throw new PluginManifestError(`Duplicate contributed command id "${id}" (${context}).`);
        }
        seen.add(id);
        return { id, title: requireString(entry, 'title', context) };
    });
}

function validateServices(value: unknown, context: string): string[] {
    if (!Array.isArray(value)) {
        throw new PluginManifestError(`"contributes.services" must be an array (${context}).`);
    }
    return value.map((entry, index) => {
        if (typeof entry !== 'string' || !entry.trim()) {
            throw new PluginManifestError(`"contributes.services[${index}]" must be a non-empty string (${context}).`);
        }
        return entry.trim();
    });
}

/**
 * Validates untrusted `plugin.json` content and returns a frozen manifest.
 *
 * This runs on the host before any plugin code is imported, so a malformed
 * manifest can never reach the module loader.
 */
export function validatePluginManifest(value: unknown, manifestPath?: string): PluginManifest {
    const context = manifestPath ?? 'plugin.json';
    if (!isRecord(value)) {
        throw new PluginManifestError('Manifest root must be a JSON object.', manifestPath);
    }

    const id = requireString(value, 'id', context);
    if (!PLUGIN_ID_PATTERN.test(id)) {
        throw new PluginManifestError(
            `"id" must be a lower-case namespaced identifier such as "bruce.terminal" (got "${id}").`,
            manifestPath
        );
    }

    const version = requireString(value, 'version', context);
    if (!SEMVER_PATTERN.test(version)) {
        throw new PluginManifestError(`"version" must be a semver string (got "${version}").`, manifestPath);
    }

    if (typeof value.apiVersion !== 'number' || !Number.isInteger(value.apiVersion)) {
        throw new PluginManifestError('"apiVersion" must be an integer.', manifestPath);
    }
    if (!SUPPORTED_API_VERSIONS.includes(value.apiVersion)) {
        throw new PluginManifestError(
            `Plugin targets API version ${value.apiVersion}; this host supports ${SUPPORTED_API_VERSIONS.join(', ')}.`,
            manifestPath
        );
    }

    if (!isRecord(value.entrypoints)) {
        throw new PluginManifestError('"entrypoints" must be an object.', manifestPath);
    }
    const entrypoints: { frontend?: string; backend?: string } = {};
    if (value.entrypoints.frontend !== undefined) {
        if (typeof value.entrypoints.frontend !== 'string') {
            throw new PluginManifestError('"entrypoints.frontend" must be a string.', manifestPath);
        }
        entrypoints.frontend = validateEntrypointPath(value.entrypoints.frontend, 'frontend');
    }
    if (value.entrypoints.backend !== undefined) {
        if (typeof value.entrypoints.backend !== 'string') {
            throw new PluginManifestError('"entrypoints.backend" must be a string.', manifestPath);
        }
        entrypoints.backend = validateEntrypointPath(value.entrypoints.backend, 'backend');
    }
    if (!entrypoints.frontend && !entrypoints.backend) {
        throw new PluginManifestError(
            'At least one of "entrypoints.frontend" or "entrypoints.backend" is required.',
            manifestPath
        );
    }

    let dependencies: Record<string, string> | undefined;
    if (value.dependencies !== undefined) {
        if (!isRecord(value.dependencies)) {
            throw new PluginManifestError('"dependencies" must be an object mapping plugin id to a range.', manifestPath);
        }
        dependencies = {};
        for (const [dependencyId, range] of Object.entries(value.dependencies)) {
            if (!PLUGIN_ID_PATTERN.test(dependencyId)) {
                throw new PluginManifestError(`Invalid dependency id "${dependencyId}".`, manifestPath);
            }
            if (typeof range !== 'string' || !range.trim()) {
                throw new PluginManifestError(
                    `Dependency "${dependencyId}" must map to a non-empty version range.`,
                    manifestPath
                );
            }
            dependencies[dependencyId] = range.trim();
        }
    }

    let contributes: PluginManifest['contributes'];
    if (value.contributes !== undefined) {
        if (!isRecord(value.contributes)) {
            throw new PluginManifestError('"contributes" must be an object.', manifestPath);
        }
        contributes = {};
        if (value.contributes.panels !== undefined) {
            (contributes as { panels?: unknown }).panels = validatePanels(value.contributes.panels, context);
        }
        if (value.contributes.commands !== undefined) {
            (contributes as { commands?: unknown }).commands = validateCommands(
                value.contributes.commands,
                context
            );
        }
        if (value.contributes.services !== undefined) {
            (contributes as { services?: unknown }).services = validateServices(
                value.contributes.services,
                context
            );
        }
    }

    const manifest: PluginManifest = {
        id,
        name: requireString(value, 'name', context),
        version,
        apiVersion: value.apiVersion,
        description: optionalString(value, 'description', context),
        entrypoints,
        dependencies,
        contributes
    };
    return Object.freeze(manifest);
}

/**
 * Minimal `x.y.z` range check used for plugin dependency ordering.
 * Supports exact versions, `^`, `~`, `>=` and `*`.
 */
export function satisfiesVersion(version: string, range: string): boolean {
    const trimmed = range.trim();
    if (trimmed === '*' || trimmed === '') {
        return true;
    }

    const parse = (input: string): number[] | undefined => {
        const match = /^(\d+)\.(\d+)\.(\d+)/.exec(input);
        return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
    };

    const actual = parse(version);
    if (!actual) {
        return false;
    }

    const operator = /^(\^|~|>=|=)?\s*(.+)$/.exec(trimmed);
    if (!operator) {
        return false;
    }
    const [, op, rawTarget] = operator;
    const target = parse(rawTarget);
    if (!target) {
        return false;
    }

    const compare = (a: number[], b: number[]): number => {
        for (let i = 0; i < 3; i++) {
            if (a[i] !== b[i]) {
                return a[i] - b[i];
            }
        }
        return 0;
    };

    switch (op) {
        case '^':
            if (target[0] > 0) {
                return compare(actual, target) >= 0 && actual[0] === target[0];
            }
            if (target[1] > 0) {
                return compare(actual, target) >= 0 && actual[0] === 0 && actual[1] === target[1];
            }
            return compare(actual, target) === 0;
        case '~':
            return compare(actual, target) >= 0 && actual[0] === target[0] && actual[1] === target[1];
        case '>=':
            return compare(actual, target) >= 0;
        default:
            return compare(actual, target) === 0;
    }
}
