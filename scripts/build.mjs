import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

const common = { bundle: true, sourcemap: watch, minify: !watch, logLevel: 'info', legalComments: 'none' };

const extension = {
  ...common,
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(dist, 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
};

const webview = {
  ...common,
  entryPoints: [join(root, 'src/webview/main.ts')],
  outfile: join(dist, 'webview.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  // KaTeX fonts are served from dist/katex; the CSS only refers to them.
  loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' },
};

function copyAssets() {
  if (!watch) rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, 'katex'), { recursive: true });
  cpSync(join(root, 'node_modules/katex/dist/katex.min.css'), join(dist, 'katex/katex.min.css'));
  // Every supported browser loads woff2, so the woff/ttf fallbacks are not shipped.
  cpSync(join(root, 'node_modules/katex/dist/fonts'), join(dist, 'katex/fonts'), { recursive: true, filter: (src) => !/\.(woff|ttf)$/.test(src) });
  // Mermaid is large, so it is loaded on demand the first time a diagram is shown.
  cpSync(join(root, 'node_modules/mermaid/dist/mermaid.min.js'), join(dist, 'mermaid.min.js'));
}

try {
  copyAssets();
  if (watch) {
    const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
