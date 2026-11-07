/*
Capture the real English webview for the feature guide.
Uses the browser test harness and genuinely headless Chromium.
Run after npm run build: node scripts/screenshots.mjs.
*/
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const overview = `# Release notes

Write **Markdown**, see the result as you type, and keep your files portable.

## Ready for review

- [x] Draft the introduction
- [x] Add tables and diagrams
- [ ] Share the final document

\`\`\`ts
const message = 'Hello, Markdown!';
console.log(message);
\`\`\`

:::tip
Paste images or files directly into your document.
:::
`;

const tables = `# Project checklist

Edit cells directly. Use Tab or Enter to move through the table.

| Task | Owner | Status | Priority |
| :--- | :--- | :--- | ---: |
| Write the outline | Alex | Complete | 1 |
| Review examples | Sam | In progress | 2 |
| Update screenshots | Casey | Planned | 3 |
| Publish the guide | Alex | Planned | 4 |

Drag row and column handles to reorder. Right-click a cell for more actions.
`;

const diagrams = String.raw`# Diagrams and math

## A writing workflow

\`\`\`mermaid
flowchart LR
    Draft[Write a draft] --> Review{Ready to share?}
    Review -->|Yes| Publish[Publish]
    Review -->|No| Draft
\`\`\`

## Equations in your notes

Inline math: $E = mc^2$.

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$
`.replaceAll('\\`', '`');

const config = {
  fontSize: 16, lineHeight: 1.6, maxWidth: 900,
  attachmentFolder: 'assets', embedImages: false,
  mermaidTheme: 'auto', tocMaxDepth: 3, blockEdit: 'doubleClick',
};

await mkdir('docs/images', { recursive: true });
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  async function open(text, mode = 'live') {
    await page.goto(pathToFileURL(resolve('tests/browser/harness.html')).href);
    await expect.poll(() => page.evaluate(() => window.sent.some(message => message.type === 'ready'))).toBe(true);
    await page.evaluate(({ text, mode, config }) => window.postMessage({
      type: 'init', text, mode, locale: 'en', baseUri: '', config, autoSaveOff: true,
    }, '*'), { text, mode, config });
    await expect(page.locator('.md-mode-button')).toBeVisible();
    await page.locator('.cm-content').blur();
    await page.evaluate(() => document.fonts.ready);
  }
  async function capture(name) {
    await page.mouse.move(1090, 590);
    await page.screenshot({ path: resolve('docs/images', `${name}.png`) });
  }

  await open(overview);
  await expect(page.locator('.md-container')).toBeVisible();
  await capture('live');
  await page.locator('.md-mode-button').click();
  await expect(page.locator('.md-menu .md-menu-item')).toHaveText(['✓Live', 'Preview', 'Source', 'Source | Preview', 'Preview | Source']);
  await capture('modes');
  await page.locator('.md-menu .md-menu-item').nth(3).click();
  await expect(page.locator('.preview-pane h1')).toHaveText('Release notes');
  await page.locator('.preview-pane').evaluate(node => node.scrollTo(0, 0));
  await expect.poll(() => page.locator('.preview-pane').evaluate(node => node.scrollTop)).toBe(0);
  await capture('split');

  await open(tables);
  const target = page.locator('.md-cell[data-row="2"][data-col="3"]');
  await target.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Insert row below/ })).toBeVisible();
  await capture('tables');

  await page.setViewportSize({ width: 1100, height: 650 });
  await open(diagrams, 'preview');
  await expect(page.locator('.md-mermaid svg')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.katex-display')).toHaveCount(1);
  await capture('diagrams-math');
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
