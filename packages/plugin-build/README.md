# @brucede/plugin-build

esbuild bundler for BruceDE plugin entrypoints.

```bash
node packages/plugin-build/build.mjs plugins/terminal   # one plugin
node packages/plugin-build/build-all.mjs                # every plugin with a plugin.json
npm run build:plugins                                   # from the repo root
```

## What it produces

- **Frontend** (`format: esm`, `platform: browser`): the bundle imports shared host modules as `/brucede-host-modules/<file>.js`. The renderer rewrites those specifiers to blob URLs backed by its own React/Lumino/Theia instances at load time, so plugin widgets are the same classes the shell uses. No import map and no duplicate React/Lumino copies are needed. The mapping lives in `workspace-core/src/common/plugin-host-protocol.ts` and is mirrored here; keep them in sync when adding a shared module.
- **Backend** (`format: esm`, `platform: node`): a self-contained ESM bundle so a user-installed plugin in `~/.brucede/plugins` does not depend on the app's `node_modules` layout. `electron` stays external.

Output paths come from the plugin's `plugin.json` `entrypoints`. Bundles are git-ignored; run the build before starting the app.
