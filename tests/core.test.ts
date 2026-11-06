import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText } from '../src/textDiff';
import { createMarkdown, resolveAgainst, slugify } from '../src/markdown';

const apply = (before: string, after: string) => {
  const change = diffText(before, after);
  return change ? before.slice(0, change.from) + change.insert + before.slice(change.to) : before;
};

test('diffText returns the minimal replacement', () => {
  assert.equal(diffText('same', 'same'), null);
  assert.deepEqual(diffText('hello world', 'hello brave world'), { from: 6, to: 6, insert: 'brave ' });
  assert.deepEqual(diffText('aaa', 'aa'), { from: 2, to: 3, insert: '' });
  for (const [a, b] of [['', 'x'], ['x', ''], ['abc', 'xyz'], ['a😀b', 'a😁b'], ['😀', '😀😀'], ['line\nline', 'line\n\nline']]) {
    assert.equal(apply(a, b), b);
  }
});

test('diffText never splits a surrogate pair', () => {
  const change = diffText('x😀', 'x😁')!;
  assert.equal(change.insert, '😁');
});

const md = createMarkdown({ resolveImage: (src) => resolveAgainst('https://file+.vscode-resource/doc/', src) });

test('renders GFM basics with source lines', () => {
  const html = md.render('# Title\n\nSome **bold** and ~~gone~~.\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n');
  assert.match(html, /<h1 id="title" data-line="0">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /<table data-line="4">/);
  assert.match(html, /style="text-align:right"/);
});

test('task lists, footnotes and TOC', () => {
  const html = md.render('[toc]\n\n## One\n\n### Two\n\n- [x] done\n- [ ] todo\n\nNote[^1].\n\n[^1]: Footnote text.\n');
  assert.match(html, /<nav class="md-toc"><ul><li class="md-toc-l2"><a href="#one">One<\/a><\/li><li class="md-toc-l3"><a href="#two">Two<\/a>/);
  assert.match(html, /<li class="md-task-item"><input type="checkbox" class="md-task" disabled checked> done/);
  assert.match(html, /<input type="checkbox" class="md-task" disabled> todo/);
  assert.match(html, /class="footnote-ref"/);
  assert.match(html, /Footnote text\./);
});

test('math: inline, block and fenced; prices are not math', () => {
  const html = md.render('Euler $e^{i\\pi}+1=0$ costs $5 and $6.\n\n$$\n\\frac{a}{b}\n$$\n\n```math\nx^2\n```\n');
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3); // one inline plus one inside each display block
  assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
  assert.match(html, /costs \$5 and \$6\./);
});

test('invalid math shows the source as an error instead of throwing', () => {
  assert.match(md.render('$$\n\\frac{\n$$\n'), /md-error/);
});

test('mermaid fences become lazy placeholders; code is highlighted', () => {
  const html = md.render('```mermaid\ngraph TD\n  A-->B\n```\n\n```js\nconst x = 1;\n```\n');
  assert.match(html, /<div class="md-mermaid" data-line="0" data-source="graph TD\n  A--&gt;B\n"><\/div>/);
  assert.match(html, /<span class="md-code-lang">js<\/span><code class="hljs"><span class="hljs-keyword">const<\/span>/);
});

test('containers wrap nested Markdown', () => {
  const html = md.render(':::warning Careful\nThis is **bold**.\n\n- item\n:::\n\nAfter\n');
  assert.match(html, /<div class="md-container md-container-warning" data-line="0">\s*<p class="md-container-title">Careful<\/p>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<li>item<\/li>/);
  assert.match(html, /<\/div>\n<p data-line="6">After<\/p>/);
});

test('relative images resolve against the document folder', () => {
  assert.match(md.render('![a](<assets/my pic.png>)'), /src="https:\/\/file\+\.vscode-resource\/doc\/assets\/my%20pic\.png"/);
  assert.equal(resolveAgainst('https://h/doc/', 'img/a b.png'), 'https://h/doc/img/a%20b.png');
  assert.equal(resolveAgainst('https://h/doc/', 'https://x/y.png'), 'https://x/y.png');
  assert.equal(resolveAgainst('https://h/doc/', 'data:image/png;base64,AA'), 'data:image/png;base64,AA');
});

test('slugify matches GitHub style, including CJK', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('中文 标题'), '中文-标题');
});
