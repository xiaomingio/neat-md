import markdownIt, { type MarkdownIt, type StateBlock, type StateCore, type StateInline, type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';

/*
 * Markdown to HTML for the preview pane and Live widgets. Rendering is pure (no DOM)
 * so it can be unit-tested in Node; callers sanitize the result before inserting it.
 */

export const CONTAINER_TYPES = ['note', 'tip', 'info', 'warning', 'danger'] as const;

export interface RenderOptions {
  /** Resolves a relative image path to a URL the webview can load. */
  resolveImage?: (src: string) => string;
  tocMaxDepth?: number;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mathCache = new Map<string, string>();

export function renderMath(tex: string, displayMode: boolean): string {
  const key = (displayMode ? 'D' : 'I') + tex;
  let html = mathCache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(tex, { displayMode, throwOnError: true, strict: 'ignore', output: 'htmlAndMathml' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      html = `<span class="md-error" title="${escapeHtml(message)}">${escapeHtml(tex)}</span>`;
    }
    if (mathCache.size > 500) mathCache.delete(mathCache.keys().next().value!);
    mathCache.set(key, html);
  }
  return html;
}

const highlightCache = new Map<string, string>();

export function highlightCode(code: string, lang: string): string {
  const key = lang + '\u0000' + code;
  let html = highlightCache.get(key);
  if (html === undefined) {
    html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escapeHtml(code);
    if (highlightCache.size > 500) highlightCache.delete(highlightCache.keys().next().value!);
    highlightCache.set(key, html);
  }
  return html;
}

/** GitHub-style heading slug. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24 /* $ */ || src.charCodeAt(start + 1) === 0x24) return false;
  const next = src.charCodeAt(start + 1);
  if (next === 0x20 || next === 0x09 || Number.isNaN(next)) return false;

  let end = start + 1;
  while ((end = src.indexOf('$', end)) !== -1) {
    if (src.charCodeAt(end - 1) === 0x5c /* \ */) { end++; continue; }
    break;
  }
  if (end === -1 || end === start + 1) return false;
  const before = src.charCodeAt(end - 1);
  if (before === 0x20 || before === 0x09) return false;
  // "$5 and $6" is prose, not math: a closing $ directly followed by a digit is rejected.
  const after = src.charCodeAt(end + 1);
  if (after >= 0x30 && after <= 0x39) return false;

  if (!silent) state.push('math_inline', 'math', 0).content = src.slice(start + 1, end);
  state.pos = end + 1;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine];
  let max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.slice(pos, pos + 2) !== '$$') return false;
  if (silent) return true;

  const first = state.src.slice(pos + 2, max);
  let line = startLine;
  let content: string;

  if (first.trim().endsWith('$$') && first.trim().length > 2) {
    content = first.trim().slice(0, -2);
  } else {
    const lines = [first];
    let closed = false;
    while (++line < endLine) {
      pos = state.bMarks[line] + state.tShift[line];
      max = state.eMarks[line];
      if (pos < max && state.sCount[line] < state.blkIndent) break;
      const text = state.src.slice(pos, max);
      if (text.trimEnd().endsWith('$$')) {
        lines.push(text.trimEnd().slice(0, -2));
        closed = true;
        break;
      }
      lines.push(text);
    }
    if (!closed) return false;
    content = lines.join('\n');
  }

  state.line = line + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, state.line];
  return true;
}

function container(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const match = /^:::\s*(\w+)\s*(.*)$/.exec(state.src.slice(start, max));
  if (!match || !(CONTAINER_TYPES as readonly string[]).includes(match[1].toLowerCase())) return false;
  if (silent) return true;

  let line = startLine;
  let closed = false;
  while (++line < endLine) {
    const lineStart = state.bMarks[line] + state.tShift[line];
    const text = state.src.slice(lineStart, state.eMarks[line]).trim();
    if (state.sCount[line] < state.blkIndent && text) break;
    if (text === ':::') { closed = true; break; }
  }

  const type = match[1].toLowerCase();
  const open = state.push('container_open', 'div', 1);
  open.attrSet('class', `md-container md-container-${type}`);
  open.info = match[2].trim() || type.charAt(0).toUpperCase() + type.slice(1);
  open.meta = { type };
  open.map = [startLine, line];
  open.block = true;

  const oldParent = state.parentType;
  const oldLineMax = state.lineMax;
  state.parentType = 'container' as typeof state.parentType;
  state.lineMax = line;
  state.md.block.tokenize(state, startLine + 1, line);
  state.parentType = oldParent;
  state.lineMax = oldLineMax;

  state.push('container_close', 'div', -1).block = true;
  state.line = closed ? line + 1 : line;
  return true;
}

/** Turns "[ ] " / "[x] " at the start of a list item into a checkbox. */
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const match = /^\[([ xX])\][ \t]/.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || !first || first.type !== 'text' || !first.content.startsWith(match[0])) continue;
    first.content = first.content.slice(match[0].length);
    inline.content = inline.content.slice(match[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" class="md-task" disabled${match[1] === ' ' ? '' : ' checked'}> `;
    inline.children!.unshift(box);
    tokens[i - 2].attrJoin('class', 'md-task-item');
  }
}

interface Heading { level: number; text: string; slug: string }

function headingIds(state: StateCore): void {
  const used = new Map<string, number>();
  const headings: Heading[] = [];
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const text = tokens[i + 1].children?.filter((t) => t.type === 'text' || t.type === 'code_inline').map((t) => t.content).join('') ?? '';
    let slug = slugify(text) || 'section';
    const count = used.get(slug) ?? 0;
    used.set(slug, count + 1);
    if (count) slug = `${slug}-${count}`;
    tokens[i].attrSet('id', slug);
    headings.push({ level: Number(tokens[i].tag.slice(1)), text, slug });
  }
  state.env.headings = headings;
}

export function renderToc(headings: Heading[], maxDepth: number): string {
  const items = headings
    .filter((h) => h.level <= maxDepth)
    .map((h) => `<li class="md-toc-l${h.level}"><a href="#${escapeHtml(h.slug)}">${escapeHtml(h.text)}</a></li>`)
    .join('');
  return `<nav class="md-toc"><ul>${items}</ul></nav>`;
}

function tableOfContents(state: StateCore, maxDepth: number): void {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length - 1; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 1].level !== 0) continue;
    if (!/^\[\[?toc\]\]?$/i.test(inline.content.trim())) continue;
    const html = new state.Token('html_block', '', 0);
    html.content = renderToc((state.env.headings as Heading[] | undefined) ?? [], maxDepth);
    html.map = tokens[i - 1].map;
    tokens.splice(i - 1, 3, html);
  }
}

/** Marks top-level blocks with their source line for scroll sync. */
function sourceLines(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.nesting >= 0 && token.block) token.attrSet('data-line', String(token.map[0]));
  }
}

export function createMarkdown(options: RenderOptions = {}): MarkdownIt {
  const md = markdownIt({ html: true, linkify: true, typographer: false });
  md.use(footnote);
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.block.ruler.before('fence', 'container', container, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.core.ruler.push('task_lists', taskLists);
  md.core.ruler.push('heading_ids', headingIds);
  md.core.ruler.push('toc', (state) => tableOfContents(state, options.tocMaxDepth ?? 3));
  md.core.ruler.push('source_lines', sourceLines);

  const rules = md.renderer.rules;
  rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
  rules.math_block = (tokens, idx) => `<div class="md-math"${lineAttr(tokens[idx])}>${renderMath(tokens[idx].content, true)}</div>\n`;
  rules.container_open = (tokens, idx, opts, _env, self) =>
    self.renderToken(tokens, idx, opts) + `<p class="md-container-title">${escapeHtml(tokens[idx].info)}</p>\n`;
  rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') return `<div class="md-mermaid"${lineAttr(token)} data-source="${escapeHtml(token.content)}"></div>\n`;
    if (lang === 'math' || lang === 'latex' || lang === 'katex') {
      return `<div class="md-math"${lineAttr(token)}>${renderMath(token.content, true)}</div>\n`;
    }
    const label = lang ? `<span class="md-code-lang">${escapeHtml(lang)}</span>` : '';
    return `<pre class="md-code"${lineAttr(token)}>${label}<code class="hljs">${highlightCode(token.content, lang)}</code></pre>\n`;
  };

  const image = rules.image!;
  rules.image = (tokens, idx, opts, env, self) => {
    const src = tokens[idx].attrGet('src');
    if (typeof src === 'string' && src && options.resolveImage) tokens[idx].attrSet('src', options.resolveImage(src));
    return image(tokens, idx, opts, env, self);
  };
  return md;
}

const lineAttr = (token: Token) => (token.map && token.level === 0 ? ` data-line="${token.map[0]}"` : '');

/** Resolves a relative image path against the document folder's webview URI. */
export function resolveAgainst(baseUri: string, src: string): string {
  if (!baseUri || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return src;
  try {
    return new URL(src.split('/').map(encodeURIComponent).join('/').replace(/%25([0-9a-f]{2})/gi, '%$1'), baseUri).toString();
  } catch {
    return src;
  }
}

/** Markdown link destination; angle brackets keep spaces and parentheses valid. */
export function linkDestination(link: string): string {
  return /[\s()<>]/.test(link) ? `<${link.replace(/[<>]/g, encodeURIComponent)}>` : link;
}
