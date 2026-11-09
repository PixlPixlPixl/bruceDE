# BruceDE

BruceDE is a plugin-first Theia desktop workspace. The initial workspace is an empty docking canvas; users install/open feature panels and decide how they are arranged. The host provides docking, plugin lifecycle, shared APIs, and platform integration—not a prescribed IDE layout.

## Development

```bash
npm ci
npm run build:electron
npm run start:electron
```

The application is pinned to Theia 1.77.0. Cordis is the selected native-plugin lifecycle engine; this branch establishes its dependencies and the plugin API/package structure. Automatic runtime loading and the host adapters are follow-on work. Plugins are trusted code, not sandboxed: read [AGENTS.md](./AGENTS.md) before developing or installing plugins.

## Repository layout

- `workspace-core/`: empty canvas, docking, panel registry and layout persistence.
- `packages/plugin-api/`: stable plugin author API contracts.
- `packages/plugin-runtime/`: Cordis dependencies and runtime entrypoints.
- `packages/ui-kit/`: optional shared visual tokens/primitives.
- `plugins/`: self-contained feature plugin packages (terminal, agent-chat, file-browser, Git).
- `electron-app/` and `browser-app/`: Theia application targets.

See [AGENTS.md](./AGENTS.md) for the product goal, native trust model, intended plugin loading flow, communication rules, and implementation direction.
