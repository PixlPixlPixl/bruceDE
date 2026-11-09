# BruceDE

A Theia-based desktop workspace built around a user-controlled, blank docking canvas.

The application deliberately does not prescribe an IDE-style layout. Its initial workspace is empty. Extensions register available panel types, and the user decides which panels to open and how to arrange them.

## Requirements

- Node.js 18 or newer
- npm 8 or newer
- The native prerequisites required by Theia/Electron

## Run the Electron application

    npm install
    npm run build:electron
    npm run start:electron

The build:electron script compiles workspace-core before bundling Theia.

## Try the docking surface

The workspace starts empty. Press F1 to open Theia's command palette and run:

**Workspace: Open docking demo layout**

This creates three temporary panels so you can verify split, tab, drag-and-drop, and resize behavior. The panels are visual placeholders; they do not start terminal or agent processes.

## Packages

- workspace-core: blank-canvas shell, shared panel registry, docking service, and demo panels.
- electron-app: Electron desktop target.
- browser-app: Browser target using the same workspace implementation.

See workspace-core/README.md for the panel contribution API.
