import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTableOp, cellEdit, displayWidth, escapeCell, parseTable, serializeTable, splitRow } from '../src/table';
import { attachmentFolder, attachmentLink, safeFileName, withSuffix } from '../src/attachments';
import { linkDestination } from '../src/markdown';
import { htmlToMarkdown } from '../src/htmlToMarkdown';
import { sanitizeConfig, DEFAULT_CONFIG } from '../src/protocol';

const TABLE = '| Name | Qty |\n| :--- | --: |\n| a | 1 |\n| b \\| c | 22 |';

test('splitRow honours escaped pipes and optional outer pipes', () => {
  assert.deepEqual(splitRow('| a | b \\| c |').map((c) => c.text), ['a', 'b \\| c']);
  assert.deepEqual(splitRow('a | b').map((c) => c.text), ['a', 'b']);
  assert.deepEqual(splitRow('|  | x |').map((c) => c.text), ['', 'x']);
});

test('parseTable reads alignment and pads short rows', () => {
  const model = parseTable('| a | b | c |\n|:-|:-:|-:|\n| 1 |')!;
  assert.deepEqual(model.aligns, ['left', 'center', 'right']);
  assert.deepEqual(model.rows[1], ['1', '', '']);
  assert.equal(parseTable('| a |\n| not a delimiter |'), null);
});

test('serializeTable pads columns, counting wide characters as two', () => {
  assert.equal(displayWidth('中文a'), 5);
  const out = serializeTable({ rows: [['名称', 'n'], ['x', '100']], aligns: [null, 'right'] });
  assert.equal(out, '| 名称 |   n |\n| ---- | --: |\n| x    | 100 |');
});

test('cellEdit replaces only the edited cell', () => {
  const change = cellEdit(TABLE, 1, 1, '7')!;
  const next = TABLE.slice(0, change.from) + change.insert + TABLE.slice(change.to);
  assert.equal(next, '| Name | Qty |\n| :--- | --: |\n| a | 7 |\n| b \\| c | 22 |');
  assert.equal(cellEdit(TABLE, 1, 1, '1'), null);
  // Header row and empty cells.
  const header = cellEdit(TABLE, 0, 0, 'Item')!;
  assert.equal(TABLE.slice(0, header.from) + header.insert + TABLE.slice(header.to), TABLE.replace('Name', 'Item'));
  const empty = '| a | b |\n| - | - |\n|  | x |';
  const e = cellEdit(empty, 1, 0, 'new')!;
  assert.equal(empty.slice(0, e.from) + e.insert + empty.slice(e.to), '| a | b |\n| - | - |\n| new | x |');
  // A short row is rewritten with enough cells.
  const short = '| a | b |\n| - | - |\n| 1 |';
  const s = cellEdit(short, 1, 1, '2')!;
  assert.equal(short.slice(0, s.from) + s.insert + short.slice(s.to), '| a | b |\n| - | - |\n| 1 | 2 |');
});

test('table operations', () => {
  const model = parseTable(TABLE)!;
  assert.deepEqual(applyTableOp(model, { kind: 'insertRow', at: 1 }).rows[1], ['', '']);
  assert.equal(applyTableOp(model, { kind: 'insertRow', at: 0 }), model, 'no row above the header');
  assert.equal(applyTableOp(model, { kind: 'deleteRow', at: 0 }), model, 'header cannot be deleted');
  assert.deepEqual(applyTableOp(model, { kind: 'moveRow', from: 2, to: 1 }).rows.map((r) => r[0]), ['Name', 'b \\| c', 'a']);
  assert.equal(applyTableOp(model, { kind: 'moveRow', from: 1, to: 0 }), model, 'header stays first');
  const moved = applyTableOp(model, { kind: 'moveCol', from: 1, to: 0 });
  assert.deepEqual(moved.rows[0], ['Qty', 'Name']);
  assert.deepEqual(moved.aligns, ['right', 'left']);
  const inserted = applyTableOp(model, { kind: 'insertCol', at: 2 });
  assert.deepEqual(inserted.rows.map((r) => r.length), [3, 3, 3]);
  assert.equal(applyTableOp({ rows: [['a']], aligns: [null] }, { kind: 'deleteCol', at: 0 }).aligns.length, 1, 'keeps one column');
  assert.equal(serializeTable(applyTableOp(model, { kind: 'align', col: 0, align: 'center' })).split('\n')[1], '| :----: | --: |');
});

test('escapeCell keeps cells on one line and escapes bare pipes only', () => {
  assert.equal(escapeCell('a | b \\| c\nd'), 'a \\| b \\| c d');
});

test('attachment folder, names and links', () => {
  assert.deepEqual(attachmentFolder('assets', 'notes.md'), { absolute: false, folder: 'assets', segments: ['assets'] });
  assert.equal(attachmentFolder('${filename}.assets', 'My Notes.md').folder, 'My Notes.assets');
  assert.deepEqual(attachmentFolder('./img/../media/', 'a.md').segments, ['media']);
  assert.deepEqual(attachmentFolder('../shared', 'a.md').segments, ['..', 'shared']);
  assert.equal(attachmentFolder('', 'a.md').folder, 'assets');
  assert.equal(attachmentFolder('/tmp/x', 'a.md').absolute, true);
  assert.equal(safeFileName('../../evil:name?.png'), 'evil_name_.png');
  assert.equal(safeFileName('截图 1.png'), '截图 1.png');
  assert.equal(withSuffix('photo.png', 2), 'photo-2.png');
  assert.equal(attachmentLink(attachmentFolder('assets', 'a.md'), 'x.png'), 'assets/x.png');
  assert.equal(attachmentLink(attachmentFolder('.', 'a.md'), 'x.png'), 'x.png');
  assert.equal(linkDestination('assets/my pic.png'), '<assets/my pic.png>');
  assert.equal(linkDestination('assets/a.png'), 'assets/a.png');
});

test('settings from the webview are validated', () => {
  assert.deepEqual(sanitizeConfig({}), DEFAULT_CONFIG);
  const c = sanitizeConfig({ fontSize: 99, lineHeight: 'x', maxWidth: -5, attachmentFolder: '  ', embedImages: 'yes', mermaidTheme: 'evil', tocMaxDepth: 9 });
  assert.deepEqual(c, { ...DEFAULT_CONFIG, fontSize: 32, maxWidth: 0, tocMaxDepth: 6 });
});

test('rich text paste becomes Markdown', () => {
  const html = '<h2>Title</h2><p>Some <b>bold</b>, <i>italic</i> and <a href="https://x.y">a link</a>.</p>'
    + '<ul><li>one</li><li>two</li></ul><pre><code class="language-js">const a = 1;</code></pre>'
    + '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
  const md = htmlToMarkdown(html);
  assert.match(md, /^## Title/);
  assert.match(md, /Some \*\*bold\*\*, \*italic\* and \[a link\]\(https:\/\/x\.y\)\./);
  assert.match(md, /- one\n- two/);
  assert.match(md, /```js\nconst a = 1;\n```/);
  assert.match(md, /\| A +\| B +\|\n\| --- \| --- \|\n\| 1 +\| 2 +\|/);
});

test('copying rendered Neat MD output gives back its source syntax', () => {
  const html = '<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span></span>'
    + '<div class="md-mermaid" data-source="graph TD\n  A--&gt;B\n"><svg></svg></div>'
    + '<pre class="md-code"><span class="md-code-lang">py</span><code class="hljs">print(1)</code></pre>'
    + '<div class="md-container md-container-tip"><p class="md-container-title">Pro tip</p><p>Body</p></div>';
  const md = htmlToMarkdown(html);
  assert.match(md, /\$x\^2\$/);
  assert.match(md, /```mermaid\ngraph TD\n  A-->B\n```/);
  assert.match(md, /```py\nprint\(1\)\n```/);
  assert.match(md, /:::tip Pro tip\nBody\n:::/);
});

test('Google Docs bold wrapper is not treated as bold', () => {
  assert.equal(htmlToMarkdown('<b style="font-weight:normal;" id="docs-internal-guid-1"><p>Plain text</p></b>'), 'Plain text');
});
