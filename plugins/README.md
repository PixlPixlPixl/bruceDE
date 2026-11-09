# Native plugins

Each child folder is a self-contained feature package. A plugin owns its manifest, package metadata, frontend/backend source, assets, and built ESM bundles. Development copies live in this repository; user-installed copies will live in BruceDE's user-data plugin directory.

All plugins are trusted native code. Frontend code runs in the normal Theia renderer and backend code in the normal Node backend. There is no plugin sandbox or per-plugin worker. The plugin manager must display and require acceptance of the full-system-access warning before enabling third-party plugins.

Current folders are scaffolds only; they do not open panels until their entrypoints are implemented and loaded by the runtime.
