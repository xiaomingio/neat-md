# Neat MD - Markdown Editor

Edit Markdown with live preview, WYSIWYG editing, Mermaid diagrams, and KaTeX math formulas in VS Code.

## Features

- **Live WYSIWYG Editing**: Typora-style instant rendering - edit markdown visually
- **Four View Modes**: Live, Source, Source | Preview, Preview | Source
- **Rich Syntax Support**: GFM, tables, task lists, footnotes, TOC, custom containers
- **Mermaid Diagrams**: Flowcharts, sequence diagrams, class diagrams, state diagrams, and more
- **Math Formulas**: KaTeX rendering for inline `$math$` and block `$$math$$`
- **Performance Optimized**: Incremental rendering, lazy diagram loading, debounced sync

## Usage

1. Open any `.md`, `.markdown`, or `.mdown` file; it opens in Neat MD
2. Pick a view mode from the button in the top-right corner (Live, Preview, Source, Source | Preview, Preview | Source). The choice applies to every Markdown file
3. Use **Reopen as Text** in the editor title bar to switch back to the plain text editor

Tables are edited in place: Tab and Enter move between cells and add a column or row at the end, drag the handles to reorder rows and columns, and right-click a cell for more. Pasted images and files are saved to an `assets` folder next to the Markdown file; rich text from web pages is converted to Markdown, and copying always gives Markdown.

## Configuration

Use the settings button in the top-right corner, or **Settings > Neat MD**: attachment folder (default `assets`, `${filename}` supported), Base64 image embedding, font size, line height, content width, diagram theme, table of contents depth and interface language.

## License

AGPL-3.0-only

See [LICENSE](LICENSE) for details.
