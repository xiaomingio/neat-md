/*
Purpose: Exercise the real webview bundle in headless Chromium: init handshake, Live rendering,
reveal-on-cursor, edits sent to the host, mode menu, settings, table grid, paste/copy and layout.
*/
import { expect, Page, test } from '@playwright/test';
import { pathToFileURL } from 'url';
import { join } from 'path';

const harness = pathToFileURL(join(__dirname, 'harness.html')).toString();
const CONFIG = { fontSize: 16, lineHeight: 1.6, maxWidth: 900, attachmentFolder: 'assets', embedImages: false, mermaidTheme: 'auto', tocMaxDepth: 3, blockEdit: 'doubleClick' };

const SAMPLE = [
  '# Title',
  '',
  'Some **bold** text and $x^2$ math.',
  '',
  '- [ ] task',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```mermaid',
  'graph TD',
  '  A-->|yes|B',
  '```',
  '',
  'End',
].join('\n');

async function open(page: Page, text = SAMPLE, mode = 'live', autoSaveOff = true) {
  await page.goto(harness);
  await expect.poll(() => page.evaluate(() => (window as any).sent.some((m: any) => m.type === 'ready'))).toBe(true);
  await page.evaluate(([text, mode, config, autoSaveOff]) => window.postMessage({ type: 'init', text, mode, locale: 'en', baseUri: 'https://example.invalid/doc/', config, autoSaveOff }, '*'), [text, mode, CONFIG, autoSaveOff] as const);
  await expect(page.locator('.cm-editor')).toBeVisible();
  await page.waitForTimeout(50);
}

const sent = (page: Page, type: string) => page.evaluate((type) => (window as any).sent.filter((m: any) => m.type === type), type);
const lastEdit = (page: Page) => page.evaluate(() => (window as any).sent.filter((m: any) => m.type === 'edit').at(-1)?.text);
const cell = (page: Page, row: number, col: number) => page.locator(`.md-cell[data-row="${row}"][data-col="${col}"]`);

test('handshake shows the document and Live renders Markdown', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.locator('.cm-content').blur();
  await expect(page.locator('.cm-line.md-h1')).toHaveText('Title');
  await expect(page.locator('.md-strong')).toHaveText('bold');
  await expect(page.locator('.md-math-inline .katex')).toHaveCount(1);
  await expect(page.locator('input.md-task')).toHaveCount(1);
  await expect(cell(page, 1, 0)).toHaveText('1');
  await expect(page.locator('.md-mermaid svg')).toHaveCount(1, { timeout: 15000 });
  // Edge labels are opaque pills on the line.
  await expect(page.locator('.md-mermaid .md-edge-pill')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('cursor reveals the syntax of the element it enters', async ({ page }) => {
  await open(page);
  await page.locator('.cm-line.md-h1').click();
  await expect(page.locator('.cm-line.md-h1')).toHaveText('# Title');
  await page.locator('.md-strong').click();
  await expect(page.locator('.cm-line.md-h1')).toHaveText('Title');
  await expect(page.locator('.cm-content')).toContainText('**bold**');
});

test('typing and formatting shortcuts send edits to the host', async ({ page }) => {
  await open(page, 'hello');
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' world');
  await expect.poll(() => lastEdit(page)).toBe('hello world');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('ControlOrMeta+b');
  await expect.poll(() => lastEdit(page)).toBe('**hello world**');
});

test('checkbox click toggles the task in the source', async ({ page }) => {
  await open(page, 'intro\n\n- [ ] task');
  await page.locator('input.md-task').click();
  await expect.poll(() => lastEdit(page)).toBe('intro\n\n- [x] task');
});

test('undo and save are forwarded after pending edits flush', async ({ page }) => {
  await open(page, 'a');
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('b');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+s');
  const tail = await page.evaluate(() => (window as any).sent.slice(-3));
  expect(tail).toEqual([{ type: 'edit', text: 'ab', step: true }, { type: 'command', command: 'undo' }, { type: 'command', command: 'save' }]);
});

test('host resets replace the text without echoing back', async ({ page }) => {
  await open(page, 'one');
  const before = await page.evaluate(() => (window as any).sent.length);
  await page.evaluate(() => window.postMessage({ type: 'reset', text: 'one\ntwo' }, '*'));
  await expect(page.locator('.cm-content')).toContainText('two');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).sent.length)).toBe(before);
});

test('mode button in the top right opens a menu of four modes', async ({ page }) => {
  await open(page);
  const button = page.locator('.md-mode-button');
  await expect(button).toHaveText('Live');
  const box = (await button.boundingBox())!;
  expect(box.y).toBeLessThan(12);
  expect(box.x + box.width).toBeGreaterThan(page.viewportSize()!.width - 80);
  await expect(page.locator('.tab')).toHaveCount(0);

  await button.click();
  const items = page.locator('.md-menu .md-menu-item');
  await expect(items).toHaveText(['✓Live', 'Preview', 'Source', 'Source | Preview', 'Preview | Source']);
  await items.nth(4).click();
  await expect(button).toHaveText('Preview | Source');
  const preview = page.locator('.preview-pane');
  await expect(preview).toBeVisible();
  await expect(preview.locator('h1')).toHaveText('Title');
  const [p, s] = await Promise.all([preview.boundingBox(), page.locator('.source-pane').boundingBox()]);
  expect(p!.x).toBeLessThan(s!.x);
  expect(await sent(page, 'setMode')).toEqual([{ type: 'setMode', mode: 'split-preview-source' }]);

  // Keyboard: open with ArrowDown, pick with Enter.
  await button.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(button).toHaveText('Source | Preview');
});

test('a mode change from another editor applies without echoing', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.postMessage({ type: 'mode', mode: 'source' }, '*'));
  await expect(page.locator('.md-mode-button')).toHaveText('Source');
  await expect(page.locator('.cm-content')).toContainText('# Title');
  expect(await sent(page, 'setMode')).toEqual([]);
});

test('settings dialog saves the attachment folder and language', async ({ page }) => {
  await open(page);
  await page.locator('.md-settings-button').click();
  const dialog = page.locator('dialog.md-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[name=attachmentFolder]')).toHaveValue('assets');
  // Asking before closing unsaved files is on by default (Markdown auto save off).
  await expect(dialog.locator('[name=autoSaveOff]')).toBeChecked();
  await dialog.locator('[name=attachmentFolder]').fill('${filename}.assets');
  await dialog.locator('[name=embedImages]').check();
  await dialog.locator('[name=locale]').selectOption('zh-CN');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const [update] = await sent(page, 'updateSettings');
  expect(update.config).toMatchObject({ attachmentFolder: '${filename}.assets', embedImages: true, fontSize: 16 });
  expect(await sent(page, 'setLocale')).toEqual([{ type: 'setLocale', locale: 'zh-CN' }]);
  await expect(page.locator('.md-mode-button')).toHaveText('实时');
});

test('table cells edit in place and change only that cell', async ({ page }) => {
  await open(page, 'Intro\n\n| Name | Qty |\n| --- | --: |\n| apple | 1 |\n| pear | 2 |\n\nAfter');
  await expect(cell(page, 1, 0)).toHaveText('apple');
  await cell(page, 1, 0).click();
  await expect(cell(page, 1, 0)).toHaveAttribute('data-editing', '1');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('**fig**');
  await expect.poll(() => lastEdit(page)).toBe('Intro\n\n| Name | Qty |\n| --- | --: |\n| **fig** | 1 |\n| pear | 2 |\n\nAfter');
  // Leaving the cell renders it again.
  await page.keyboard.press('Tab');
  await expect(cell(page, 1, 0).locator('strong')).toHaveText('fig');
  await expect(cell(page, 1, 1)).toBeFocused();
});

test('Tab in the last column adds a column; Enter in the last row adds a row', async ({ page }) => {
  await open(page, 'Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, 0)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell(page, 1, 1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cell(page, 1, 2)).toBeFocused();
  await expect.poll(() => lastEdit(page)).toBe('Intro\n\n| a   | b   |     |\n| --- | --- | --- |\n| 1   | 2   |     |\n');
  await page.keyboard.press('Enter');
  await expect(cell(page, 2, 2)).toBeFocused();
  await page.keyboard.type('x');
  await expect.poll(() => lastEdit(page)).toBe('Intro\n\n| a   | b   |     |\n| --- | --- | --- |\n| 1   | 2   |     |\n|     |     | x |\n');
  // Shift+Tab goes back.
  await page.keyboard.press('Shift+Tab');
  await expect(cell(page, 2, 1)).toBeFocused();
});

test('rows and columns reorder by dragging their handles', async ({ page }) => {
  await open(page, 'Intro\n\n| a | b |\n| - | - |\n| 1 | x |\n| 2 | y |\n| 3 | z |\n');
  const row3 = page.locator('.md-grid tbody tr').nth(2);
  await row3.hover();
  const grip = row3.locator('.md-grip-row');
  await expect(grip).toBeVisible();
  const g = (await grip.boundingBox())!;
  const first = (await page.locator('.md-grid tbody tr').nth(0).boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + 4, first.y + 4, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => lastEdit(page)).toBe('Intro\n\n| a   | b   |\n| --- | --- |\n| 3   | z   |\n| 1   | x   |\n| 2   | y   |\n');

  const header = page.locator('.md-grid thead th').nth(1);
  await header.hover();
  const colGrip = header.locator('.md-grip-col');
  const c = (await colGrip.boundingBox())!;
  const firstCol = (await page.locator('.md-grid thead th').nth(0).boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstCol.x + 4, c.y + 4, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => lastEdit(page)).toBe('Intro\n\n| b   | a   |\n| --- | --- |\n| z   | 3   |\n| x   | 1   |\n| y   | 2   |\n');
});

test('context menu edits structure; source only after Edit as Markdown', async ({ page }) => {
  await open(page, 'Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter');
  await cell(page, 1, 0).click({ button: 'right' });
  await page.locator('.md-menu-item', { hasText: 'Delete row' }).click();
  await expect.poll(() => lastEdit(page)).toBe('Intro\n\n| a   | b   |\n| --- | --- |\n| 3   | 4   |\n\nAfter');
  await expect(cell(page, 1, 0)).toBeFocused();

  // Arrow keys into the table focus a cell, never the source.
  await page.locator('.cm-line', { hasText: 'Intro' }).click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(cell(page, 0, 0)).toBeFocused();

  await cell(page, 1, 0).hover();
  await page.locator('.md-grid-tool[title="Edit as Markdown"]').click();
  await expect(page.locator('.md-grid')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('| a   | b   |');
  await page.locator('.cm-line', { hasText: 'After' }).click();
  await expect(page.locator('.md-grid')).toHaveCount(1);
});

test('wide tables keep natural column widths and scroll', async ({ page }) => {
  const cols = 14;
  const head = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
  const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
  const row = `| ${Array.from({ length: cols }, (_, i) => `value ${i + 1}`).join(' | ')} |`;
  await open(page, `Intro\n\n${head}\n${sep}\n${row}\n`);
  const widths = await page.locator('.md-grid thead th').evaluateAll((ths) => ths.map((th) => th.getBoundingClientRect().width));
  expect(Math.min(...widths)).toBeGreaterThan(80);
  const scroll = page.locator('.md-grid-scroll');
  expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(page.locator('.md-grid-scroll.md-scroll-right')).toHaveCount(1);
});

test('pasted image is saved by the host and linked', async ({ page }) => {
  await open(page, 'Text');
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }));
    document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await sent(page, 'saveFile')).length).toBe(1);
  const [save] = await sent(page, 'saveFile');
  expect(save.name).toMatch(/^image-\d{8}-\d{6}\.png$/);
  expect(save.dataUrl).toMatch(/^data:image\/png;base64,/);
  await page.evaluate((id) => window.postMessage({ type: 'fileSaved', id, link: 'assets/shot.png' }, '*'), save.id);
  await expect.poll(() => lastEdit(page)).toMatch(/^Text !\[image-\d{8}-\d{6}\]\(assets\/shot\.png\)$/);
});

test('pasted rich text becomes Markdown', async ({ page }) => {
  await open(page, 'start');
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>Hello <b>web</b> <a href="https://x.y">link</a></p>');
    data.setData('text/plain', 'Hello web link');
    document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => lastEdit(page)).toBe('startHello **web** [link](https://x.y)');
});

test('copy gives the Markdown source in Live mode and in the preview', async ({ page }) => {
  await open(page, 'Some **bold** text');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    document.querySelector('.cm-content')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });
  expect(copied).toBe('Some **bold** text');

  await page.evaluate(() => window.postMessage({ type: 'mode', mode: 'split-source-preview' }, '*'));
  await expect(page.locator('.preview-body p')).toHaveText('Some bold text');
  const fromPreview = await page.evaluate(() => {
    const p = document.querySelector('.preview-body p')!;
    getSelection()!.selectAllChildren(p);
    const data = new DataTransfer();
    p.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });
  expect(fromPreview).toBe('Some **bold** text');
});

test('wrapped list lines align with the text after the bullet', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 600 });
  const long = 'This list item is long enough to wrap onto several lines in a narrow window so alignment shows.';
  await open(page, `Intro\n\n- ${long}\n  - Nested ${long}\n1. Numbered ${long}`);
  await page.locator('.cm-line', { hasText: 'Intro' }).click();
  for (const needle of ['This list', 'Nested', 'Numbered']) {
    const [first, wrapped] = await page.evaluate((needle) => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent!.startsWith(needle) || l.textContent!.includes(needle))!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode()) && !node.textContent!.includes(needle));
      const range = document.createRange();
      range.selectNodeContents(node!);
      const rects = [...range.getClientRects()];
      return [rects[0].left, rects[rects.length - 1].left];
    }, needle);
    expect(Math.abs(first - wrapped), needle).toBeLessThan(1.5);
  }
});

test('search panel controls are vertically aligned', async ({ page }) => {
  await open(page);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+f');
  const panel = page.locator('.cm-search');
  await expect(panel).toBeVisible();
  const label = panel.locator('label').first();
  const [box, text] = await Promise.all([label.locator('input').boundingBox(), label.boundingBox()]);
  expect(Math.abs((box!.y + box!.height / 2) - (text!.y + text!.height / 2))).toBeLessThan(1.5);
});

test('large document stays responsive while typing in Live mode', async ({ page }) => {
  const block = '## Section\n\nParagraph with **bold**, `code`, a [link](https://x.y) and $a+b$.\n\n- item one\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1;\n```\n\n';
  await open(page, '# Title\n\n' + block.repeat(150) + 'End');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  const ms = await page.evaluate(async () => {
    const content = document.querySelector('.cm-content') as HTMLElement;
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      document.execCommand('insertText', false, 'x');
      content.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length * 0.9)];
  });
  console.log(`p90 keystroke-to-frame: ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(50);
});

test('each new undo step is reported; VS Code undo/redo replays it', async ({ page }) => {
  await open(page, 'a');
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('b');
  await page.waitForTimeout(700);
  await page.keyboard.type('c');
  await expect.poll(async () => (await sent(page, 'edit')).filter((m: any) => m.step).map((m: any) => m.text)).toEqual(['ab', 'abc']);
  await expect(page.locator('.md-undo-button')).toBeEnabled();
  await expect(page.locator('.md-redo-button')).toBeDisabled();

  await page.evaluate(() => window.postMessage({ type: 'history', action: 'undo' }, '*'));
  await expect.poll(() => lastEdit(page)).toBe('ab');
  await expect(page.locator('.md-redo-button')).toBeEnabled();
  await page.evaluate(() => window.postMessage({ type: 'history', action: 'redo' }, '*'));
  await expect.poll(() => lastEdit(page)).toBe('abc');
  // Replayed steps are not reported as new steps.
  expect((await sent(page, 'edit')).filter((m: any) => m.step)).toHaveLength(2);

  await page.locator('.md-undo-button').click();
  expect((await sent(page, 'command')).at(-1)).toEqual({ type: 'command', command: 'undo' });
});

test('the host can ask for the latest text before saving', async ({ page }) => {
  await open(page, 'x');
  await page.locator('.cm-content').click();
  await page.keyboard.press('End');
  await page.keyboard.type('yz', { delay: 20 });
  await page.evaluate(() => window.postMessage({ type: 'requestText', id: 7 }, '*'));
  await expect.poll(async () => (await sent(page, 'text')).at(-1)).toEqual({ type: 'text', id: 7, text: 'xyz' });
});

test('Preview renders like Live but cannot be edited', async ({ page }) => {
  await open(page, SAMPLE, 'preview');
  await expect(page.locator('.md-mode-button')).toHaveText('Preview');
  await expect(page.locator('.cm-line.md-h1')).toHaveText('Title');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await page.locator('.cm-line.md-h1').click();
  await page.keyboard.type('zzz');
  await expect(page.locator('.cm-line.md-h1')).toHaveText('Title');
  await expect(cell(page, 1, 0)).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('input.md-task')).toBeDisabled();
  await expect(page.locator('.md-grid-tools')).toHaveCount(0);
  await expect(page.locator('.md-undo-button')).toBeHidden();
  expect(await sent(page, 'edit')).toEqual([]);
  // Switching back to Live makes it editable again.
  await page.evaluate(() => window.postMessage({ type: 'mode', mode: 'live' }, '*'));
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await expect(cell(page, 1, 0)).toHaveAttribute('contenteditable', 'plaintext-only');
});

test('formulas open on double-click with the rendering kept below; code opens on a click', async ({ page }) => {
  await open(page, 'Intro\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nEnd');
  await page.locator('.cm-line', { hasText: 'End' }).click();
  const math = page.locator('.md-math');
  await expect(math).toBeVisible();
  const box = (await math.locator('.katex').boundingBox())!;
  // A single click does not open it, so the page does not move.
  // (KaTeX keeps the TeX in hidden MathML, so look for a source line, not just the text.)
  const sourceLine = page.locator('.cm-content > .cm-line', { hasText: '\\int_0^1' });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(sourceLine).toHaveCount(0);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(sourceLine).toHaveCount(1);
  // The rendered formula stays under its source and follows edits.
  const preview = page.locator('.md-math.md-src-preview');
  await expect(preview).toBeVisible();
  const source = (await page.locator('.cm-line', { hasText: '\\int_0^1' }).boundingBox())!;
  expect((await preview.boundingBox())!.y).toBeGreaterThan(source.y);
  await page.locator('.cm-line', { hasText: '\\int_0^1' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' + y');
  await expect(preview.locator('.katex')).toContainText('y');

  await page.locator('.cm-line', { hasText: 'End' }).click();
  const second = page.locator('.md-code code .hljs-keyword').nth(1);
  const k = (await second.boundingBox())!;
  await page.mouse.click(k.x + 2, k.y + k.height / 2);
  await expect(page.locator('.md-code')).toHaveCount(0);
  const line = await page.evaluate(() => getSelection()!.anchorNode!.parentElement!.closest('.cm-line')!.textContent);
  expect(line).toBe('const b = 2;');
});

test('edited code uses the same font and colors as the rendered block', async ({ page }) => {
  await open(page, 'Intro\n\n```js\nconst a = 1;\n```\n\nEnd');
  await page.locator('.cm-line', { hasText: 'End' }).click();
  const rendered = await page.locator('.md-code code').evaluate((el) => {
    const s = getComputedStyle(el);
    return { font: s.fontFamily, size: s.fontSize, keyword: getComputedStyle(el.querySelector('.hljs-keyword')!).color };
  });
  await page.locator('.md-code').click();
  const edited = await page.locator('.cm-line.md-code-line', { hasText: 'const a' }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { font: s.fontFamily, size: s.fontSize, keyword: getComputedStyle(el.querySelector('.hljs-keyword')!).color };
  });
  expect(edited).toEqual(rendered);
});

test('adding a column keeps the table scrolled where it was', async ({ page }) => {
  const cols = 12;
  const head = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
  const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
  const row = `| ${Array.from({ length: cols }, (_, i) => `value ${i + 1}`).join(' | ')} |`;
  await open(page, `Intro\n\n${head}\n${sep}\n${row}\n`);
  const scroll = page.locator('.md-grid-scroll');
  await scroll.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await cell(page, 1, cols - 1).click();
  const before = await scroll.evaluate((el) => el.scrollLeft);
  expect(before).toBeGreaterThan(200);
  await page.keyboard.press('Tab');
  await expect(cell(page, 1, cols)).toBeFocused();
  const after = await scroll.evaluate((el) => el.scrollLeft);
  expect(after).toBeGreaterThanOrEqual(before);
});

test('inline math: clicking anywhere on it opens its source; hover shows a border', async ({ page }) => {
  await open(page, 'Intro\n\nEnergy $\\frac{a^2}{b_1} + \\sqrt{x}$ here.\n\nEnd');
  await page.locator('.cm-line', { hasText: 'End' }).click();
  const math = page.locator('.md-math-inline');
  await math.hover();
  expect(await math.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  const box = (await math.boundingBox())!;
  // Middle, and low on the fraction's denominator.
  for (const y of [box.y + box.height / 2, box.y + box.height - 3]) {
    await page.locator('.cm-line', { hasText: 'End' }).click();
    await expect(math).toBeVisible();
    await page.mouse.click(box.x + box.width / 2, y);
    await expect(page.locator('.md-math-inline')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toContainText('$\\frac{a^2}{b_1}');
  }
});

test('clearing "ask to save" asks the host to restore auto save for Markdown', async ({ page }) => {
  await open(page);
  await page.locator('.md-settings-button').click();
  const dialog = page.locator('dialog.md-dialog');
  await dialog.locator('[name=autoSaveOff]').uncheck();
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect(await sent(page, 'setAutoSaveOff')).toEqual([{ type: 'setAutoSaveOff', off: false }]);
});

test('tables: no space above, clicks above do not edit, buttons stay off the table', async ({ page }) => {
  await open(page, 'Intro text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter');
  const table = page.locator('.md-grid table');
  const t = (await table.boundingBox())!;
  const blank = (await page.locator('.cm-line').nth(1).boundingBox())!;
  // The table starts right below the blank line that separates it from the paragraph.
  expect(Math.abs(t.y - (blank.y + blank.height))).toBeLessThan(2);

  // A click just above the table (on the blank line) and beside it does not start editing.
  for (const [x, y] of [[t.x + 20, t.y - 4], [t.x + t.width + 60, t.y + t.height / 2]]) {
    await page.mouse.click(x, y);
    await expect(page.locator('.md-cell[data-editing]')).toHaveCount(0);
  }
  await page.mouse.click(t.x + 20, t.y + 10);
  await expect(cell(page, 0, 0)).toBeFocused();

  // Buttons appear outside the table, never on it.
  await cell(page, 1, 1).hover();
  const tools = (await page.locator('.md-grid-tools').boundingBox())!;
  const overlaps = tools.x < t.x + t.width && tools.x + tools.width > t.x && tools.y < t.y + t.height && tools.y + tools.height > t.y;
  expect(overlaps).toBe(false);
  expect(tools.x).toBeGreaterThanOrEqual(t.x + t.width);
});

test('wide tables: buttons go just outside the content area, or above when there is no room', async ({ page }) => {
  const cols = 14;
  const head = `| ${Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ')} |`;
  const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
  await open(page, `Intro\n\n${head}\n${sep}\n| ${Array(cols).fill('x').join(' | ')} |\n`);
  const offTable = async () => {
    await cell(page, 1, 0).hover();
    const tools = (await page.locator('.md-grid-tools').boundingBox())!;
    const scroll = (await page.locator('.md-grid-scroll').boundingBox())!;
    expect(tools.x + tools.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    return { tools, scroll };
  };
  let { tools, scroll } = await offTable();
  expect(tools.x).toBeGreaterThanOrEqual(scroll.x + scroll.width);

  await page.setViewportSize({ width: 560, height: 650 });
  await page.mouse.move(0, 0);
  ({ tools, scroll } = await offTable());
  expect(tools.y + tools.height).toBeLessThanOrEqual(scroll.y + 0.5);
});

test('double-clicking a tall diagram brings its source into view', async ({ page }) => {
  const nodes = Array.from({ length: 14 }, (_, i) => `    N${i} --> N${i + 1}`).join('\n');
  const filler = Array.from({ length: 30 }, (_, i) => `Line ${i}`).join('\n\n');
  await open(page, `${filler}\n\n\`\`\`mermaid\nflowchart TD\n${nodes}\n\`\`\`\n\nEnd`);
  await page.locator('.cm-content').blur();
  await page.evaluate(() => { document.querySelector('.cm-scroller')!.scrollTop = 1e6; });
  const diagram = page.locator('.md-mermaid svg');
  await expect(diagram).toBeVisible({ timeout: 15000 });
  const box = (await page.locator('.md-mermaid').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, Math.min(box.y + box.height - 20, page.viewportSize()!.height - 20));
  const source = page.locator('.cm-line', { hasText: 'flowchart TD' });
  await expect(source).toBeVisible();
  await expect.poll(async () => {
    const b = await source.boundingBox();
    return !!b && b.y >= 0 && b.y + b.height <= page.viewportSize()!.height;
  }).toBe(true);
});

test('clicks below rendered blocks land on the clicked line', async ({ page }) => {
  const blocks = ['```js\na\nb\n```', '$$\nx^2\n$$', ':::tip\nBody\n:::', '```ts\nc\n```', '$$\n\\frac{a}{b}\n$$', '[toc]', '# Heading'];
  const text = ['Intro', ...blocks.flatMap((b, i) => ['', b, '', `Target line ${i}`]), '', 'End'].join('\n');
  await open(page, text);
  await page.locator('.cm-line', { hasText: 'End' }).click();
  for (let i = 0; i < blocks.length; i++) {
    const line = page.locator('.cm-line', { hasText: `Target line ${i}` });
    const box = (await line.boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + box.height / 2);
    const got = await page.evaluate(() => {
      const node = getSelection()!.anchorNode!;
      return (node instanceof Element ? node : node.parentElement)!.closest('.cm-line')!.textContent;
    });
    expect(got, `after block ${i}`).toBe(`Target line ${i}`);
  }
});

test('single-click editing can be chosen in settings', async ({ page }) => {
  await open(page, 'Intro\n\n$$\nx^2\n$$\n\nEnd');
  await page.locator('.md-settings-button').click();
  const dialog = page.locator('dialog.md-dialog');
  await expect(dialog.locator('[name=blockEdit]')).toHaveValue('doubleClick');
  await dialog.locator('[name=blockEdit]').selectOption('click');
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await sent(page, 'updateSettings'))[0].config.blockEdit).toBe('click');
  await page.locator('.cm-line', { hasText: 'End' }).click();
  await page.locator('.md-math .katex').click();
  await expect(page.locator('.cm-content > .cm-line', { hasText: 'x^2' })).toHaveCount(1);
});

test('the table of contents opens on double-click; its links still work on a click', async ({ page }) => {
  await open(page, '[toc]\n\n## One\n\ntext\n\n## Two\n\nEnd');
  await page.locator('.cm-line', { hasText: 'End' }).click();
  await page.locator('.md-toc a', { hasText: 'Two' }).click();
  await expect(page.locator('.cm-content > .cm-line', { hasText: '[toc]' })).toHaveCount(0);
  const toc = page.locator('.md-toc-block');
  const box = (await toc.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width - 20, box.y + box.height / 2);
  await expect(page.locator('.cm-content > .cm-line', { hasText: '[toc]' })).toHaveCount(1);
  await expect(page.locator('.md-toc-block.md-src-preview')).toBeVisible();
});

test('double-clicking in Preview opens Live there without remembering the mode', async ({ page }) => {
  await open(page, 'Intro\n\nSecond paragraph here\n\nEnd', 'preview');
  const line = page.locator('.cm-line', { hasText: 'Second paragraph' });
  const box = (await line.boundingBox())!;
  await page.mouse.dblclick(box.x + 40, box.y + box.height / 2);
  await expect(page.locator('.md-mode-button')).toHaveText('Live');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.type('X');
  await expect.poll(() => lastEdit(page)).toMatch(/^Intro\n\nSe?X?/);
  expect(await sent(page, 'setMode')).toEqual([]);
});
