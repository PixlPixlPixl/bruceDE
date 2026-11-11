# @icebox/plugin-runtime

Cordis is the lifecycle engine for trusted native Icebox plugins.

## What is here

- **`CordisPluginManager`** — runs each plugin inside its own Cordis fiber, resolves the module's `activate` export, builds the typed API, and drains the plugin's disposers in reverse order on unload and on failure.
- **`validatePluginManifest`** — strict, throw-on-invalid validation used by the host before any plugin code is imported.
- **`DisposerBag` / `toDisposer`** — deterministic cleanup for disposers a plugin registers imperatively.
- **`satisfiesVersion`** — small `x.y.z` range check used for plugin dependency ordering.
- `Context` and `Fiber` are re-exported from Cordis core for host code.

```ts
import { CordisPluginManager } from '@icebox/plugin-runtime';

const manager = new CordisPluginManager<FrontendPluginAPI>({ onError });
await manager.load({
    manifest,
    loadModule: () => import(bundleUrl),
    createApi: (ctx, bag) => buildApi(manifest, ctx, bag)
});
await manager.unload(manifest.id); // disposes the fiber and its effects
```

## Boundaries

- Import `@icebox/plugin-runtime` for Cordis core in either host context.
- Import `@icebox/plugin-runtime/loader` only from the Theia Node backend.
- The renderer-side module loading (fetching and importing ESM bundles, host-module shims) lives in `workspace-core`, not here: it is Theia-specific.

Cordis manages lifecycle and dependencies; the Icebox host adapts Cordis contexts to `@icebox/plugin-api`, panel registration, Theia RPC, and panel ownership. Cordis does not sandbox plugins or guarantee that ESM module records are removed from memory after disposal.

## Verification

`node packages/plugin-runtime/verify-runtime.mjs` (after `npm run build:plugin-packages`) checks manifest validation, folder discovery, host-module rewriting, and Cordis activation/disposal without a DOM.
