# Neat MD - Markdown Editor

English | [简体中文](README.zh-CN.md)

Edit and read Markdown in VS Code. Write with live rendering, work directly in source, or keep source and preview side by side.

## Features

- Five view modes: Live, Preview, Source, Source | Preview, and Preview | Source.
- Interactive tables with cell editing, row/column actions, and drag reordering.
- Mermaid diagrams, KaTeX math, syntax-highlighted code, task lists, footnotes, and a table of contents.
- Image and file paste/drop, rich-text conversion, and Markdown copying.
- Formatting shortcuts, find/replace, Undo/Redo, Save As, and unsaved-change recovery.
- VS Code themes and an English/Simplified Chinese interface.

See the [feature guide and screenshots](MARKETPLACE.md).

## Install and open

Requires desktop VS Code 1.95 or newer. Install a VSIX using **Extensions → Install from VSIX…**, then open a `.md`, `.markdown`, or `.mdown` file. Use **Reopen Editor With → Neat MD** if needed.

Choose a mode from the top-right button. **Reopen as Text** in the editor title bar returns to VS Code's text editor.

## Development

Requires Node.js and npm.

```sh
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:ui
npm run package
```

`src/extension.ts` registers the editor; `src/markdown.ts` renders Markdown; `src/webview/` implements editing and preview. Tests are in `tests/`, and a sample document is in `examples/`.

Screenshots are in `docs/images/`; refresh them with `npm run build && node scripts/screenshots.mjs`. Build output goes to `dist/`, and VSIX packages go to `release/`. Packaging uses [MARKETPLACE.md](MARKETPLACE.md) as the extension overview.

## License

Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`).
