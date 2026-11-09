# @brucede/plugin-runtime

Cordis is the lifecycle engine for trusted native BruceDE plugins.

- Import `@brucede/plugin-runtime` for Cordis core (`Context`, Fibers, services, effects, and events) in either native host context.
- Import `@brucede/plugin-runtime/loader` only from the Theia Node backend. It exposes Cordis's filesystem/module loader for backend plugin entrypoints.
- Frontend plugin bundles are native ESM imported into the existing renderer and attached to a renderer-side Cordis context. The frontend loader is host-owned; do not import the Node loader subpath into browser code.

Cordis manages lifecycle and dependencies; the BruceDE host adapts Cordis contexts to `@brucede/plugin-api`, panel registration, Theia RPC, and panel ownership. Cordis does not sandbox plugins or guarantee that ESM module records are removed from memory after disposal.
