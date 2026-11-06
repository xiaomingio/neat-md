import { EditorState, Extension, Range, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { CONTAINER_TYPES, highlightCode, renderMath, renderToc } from '../markdown';
import { mermaidHeights, mountMermaid, renderMermaid, sanitize } from './rich';
import { focusCell, gridAt, setTableHooks, showTableSource, TableWidget } from './tableWidget';
import { ownStep } from './editor';
import { t } from './i18n';

/*
 * Typora-style Live mode on top of the CodeMirror document. Markdown syntax is hidden
 * unless the cursor touches it; block elements (code, diagrams, math, tables,
 * containers, TOC) are shown as rendered widgets until the cursor enters them.
 * The text itself is never altered, so saved files stay plain Markdown.
 */

export interface LiveContext {
  renderHtml(markdown: string): string;
  renderInline(markdown: string): string;
  openLink(href: string): void;
  resolveImage(src: string): string;
  tocMaxDepth(): number;
  theme(): string;
  /** How formulas, diagrams and the table of contents open for editing. */
  blockEdit(): 'doubleClick' | 'click';
}

let context: LiveContext;

/** Forces widgets to rebuild, e.g. after a theme or setting change. */
export const refreshLive = StateEffect.define<null>();
const setFocus = StateEffect.define<boolean>();

const focusField = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setFocus) ? e.value : v), value),
});

const touches = (state: EditorState, from: number, to: number) =>
  state.field(focusField) && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

const lineTouches = (state: EditorState, pos: number) => {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
};

// ---------------------------------------------------------------- widgets

/*
 * Block widgets are wrapped in a padded box: CodeMirror measures widget heights without
 * margins, so spacing done with margins would shift every click below the block.
 */
function wrap(inner: HTMLElement): HTMLElement {
  const outer = document.createElement('div');
  outer.className = 'md-block';
  outer.append(inner);
  return outer;
}

const doubleClickHint = (inner: HTMLElement) => {
  if (context.blockEdit() === 'doubleClick') inner.title = t('Double-click to edit');
};

abstract class BlockWidget extends WidgetType {
  constructor(readonly key: string) { super(); }
  eq(other: WidgetType): boolean { return other instanceof BlockWidget && other.constructor === this.constructor && other.key === this.key; }
  ignoreEvent(): boolean { return false; }
}

class CodeWidget extends BlockWidget {
  constructor(readonly code: string, readonly lang: string) { super(lang + '\u0000' + code); }
  toDOM(): HTMLElement {
    const pre = document.createElement('pre');
    pre.className = 'md-code md-live-block';
    pre.innerHTML = (this.lang ? `<span class="md-code-lang"></span>` : '') + `<code class="hljs">${highlightCode(this.code, this.lang)}</code>`;
    if (this.lang) pre.firstElementChild!.textContent = this.lang;
    return wrap(pre);
  }
}

class MermaidWidget extends BlockWidget {
  constructor(readonly source: string) { super(context.theme() + '\u0000' + context.blockEdit() + '\u0000' + source); }
  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement('div');
    div.className = 'md-mermaid md-live-block';
    doubleClickHint(div);
    mountMermaid(div, this.source, t('Rendering diagram…'), () => view.requestMeasure());
    return wrap(div);
  }
  get estimatedHeight(): number { return mermaidHeights.get(this.source) ?? 120; }
}

class MathWidget extends BlockWidget {
  constructor(readonly tex: string) { super(context.blockEdit() + '\u0000' + tex); }
  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'md-math md-live-block';
    doubleClickHint(div);
    div.innerHTML = renderMath(this.tex, true);
    return wrap(div);
  }
}

class HtmlWidget extends BlockWidget {
  constructor(readonly markdown: string, readonly className: string) { super(className + '\u0000' + markdown); }
  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement('div');
    div.className = `md-body md-live-block ${this.className}`;
    div.innerHTML = sanitize(context.renderHtml(this.markdown));
    for (const el of div.querySelectorAll<HTMLElement>('.md-mermaid[data-source]')) {
      mountMermaid(el, el.dataset.source!, t('Rendering diagram…'), () => view.requestMeasure());
    }
    return wrap(div);
  }
}

interface TocEntry { level: number; text: string; pos: number }

class TocWidget extends BlockWidget {
  constructor(readonly entries: TocEntry[], readonly preview = false) {
    super(JSON.stringify([context.blockEdit(), preview, entries.map((e) => [e.level, e.text])]));
  }
  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement('div');
    div.className = `md-body md-live-block md-toc-block${this.preview ? ' md-src-preview' : ''}`;
    if (!this.preview) doubleClickHint(div);
    div.innerHTML = renderToc(this.entries.map((e) => ({ ...e, slug: String(e.pos) })), context.tocMaxDepth());
    div.addEventListener('mousedown', (event) => {
      const link = (event.target as HTMLElement).closest('a');
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      // Look the heading up at click time; positions move as the document changes.
      const index = [...div.querySelectorAll('a')].indexOf(link);
      const entry = headings(view.state).filter((h) => h.level <= context.tocMaxDepth())[index];
      if (entry) view.dispatch({ selection: { anchor: entry.pos }, effects: EditorView.scrollIntoView(entry.pos, { y: 'start', yMargin: 24 }) });
      view.focus();
    });
    return wrap(div);
  }
}

/*
 * Shown under the source of a formula or diagram while it is being edited, so the page
 * only grows by the source lines instead of collapsing to them (as Typora does).
 */
class MathPreviewWidget extends WidgetType {
  constructor(readonly tex: string) { super(); }
  eq(other: WidgetType): boolean { return other instanceof MathPreviewWidget && other.tex === this.tex; }
  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'md-math md-live-block md-src-preview';
    div.innerHTML = renderMath(this.tex, true);
    return wrap(div);
  }
  updateDOM(dom: HTMLElement): boolean {
    const inner = dom.firstElementChild as HTMLElement | null;
    if (!inner?.matches('.md-math.md-src-preview')) return false;
    inner.innerHTML = renderMath(this.tex, true);
    return true;
  }
  ignoreEvent(): boolean { return false; }
}

const previewTimers = new WeakMap<HTMLElement, number>();

class MermaidPreviewWidget extends WidgetType {
  constructor(readonly source: string) { super(); }
  eq(other: WidgetType): boolean { return other instanceof MermaidPreviewWidget && other.source === this.source; }
  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement('div');
    div.className = 'md-mermaid md-live-block md-src-preview';
    mountMermaid(div, this.source, t('Rendering diagram…'), () => view.requestMeasure());
    return wrap(div);
  }
  /** Re-renders shortly after typing stops, keeping the last good diagram until the new one is ready. */
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const inner = dom.firstElementChild as HTMLElement | null;
    if (!inner?.matches('.md-mermaid.md-src-preview')) return false;
    window.clearTimeout(previewTimers.get(inner));
    const source = this.source;
    inner.dataset.pending = source;
    previewTimers.set(inner, window.setTimeout(() => {
      renderMermaid(source).then(
        (svg) => {
          if (inner.dataset.pending !== source) return;
          inner.innerHTML = svg;
          view.requestMeasure();
        },
        (error: unknown) => {
          if (inner.dataset.pending !== source) return;
          let box = inner.querySelector<HTMLElement>(':scope > .md-error');
          if (!box) { box = document.createElement('div'); box.className = 'md-error'; inner.append(box); }
          box.textContent = error instanceof Error ? error.message : String(error);
          view.requestMeasure();
        }
      );
    }, 250));
    return true;
  }
  get estimatedHeight(): number { return mermaidHeights.get(this.source) ?? 120; }
  ignoreEvent(): boolean { return false; }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(other: CheckboxWidget): boolean { return other.checked === this.checked; }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'md-task';
    box.checked = this.checked;
    box.disabled = view.state.readOnly;
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      // The widget may cover the bullet too; find the "[ ]" on its line at click time.
      const line = view.state.doc.lineAt(view.posAtDOM(box));
      const match = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(line.text);
      if (!match) return;
      const at = line.from + match[1].length + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: match[2] === ' ' ? 'x' : ' ' }, userEvent: 'input.toggle', annotations: ownStep });
    });
    return box;
  }
  ignoreEvent(): boolean { return true; }
}

class MarkerWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super(); }
  eq(other: MarkerWidget): boolean { return other.text === this.text && other.className === this.className; }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `md-list-marker ${this.className}`;
    span.textContent = this.text;
    return span;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  eq(other: ImageWidget): boolean { return other.src === this.src && other.alt === this.alt; }
  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement('img');
    img.className = 'md-image';
    // The line grows once the image loads; keep click positions below it right.
    img.addEventListener('load', () => view.requestMeasure());
    img.alt = this.alt;
    img.src = context.resolveImage(this.src);
    // Pasted images are written by the host asynchronously; retry once.
    img.addEventListener('error', () => {
      if (img.dataset.retried) return;
      img.dataset.retried = '1';
      setTimeout(() => { img.src = context.resolveImage(this.src) + (this.src.includes('?') ? '&' : '?') + 'r=' + Date.now(); }, 400);
    }, { once: false });
    return img;
  }
  ignoreEvent(): boolean { return false; }
}

class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super(); }
  eq(other: TextWidget): boolean { return other.text === this.text && other.className === this.className; }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = this.className;
    span.textContent = this.text;
    return span;
  }
}

class InlineMathWidget extends WidgetType {
  constructor(readonly tex: string) { super(); }
  eq(other: InlineMathWidget): boolean { return other.tex === this.tex; }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'md-math-inline';
    span.innerHTML = renderMath(this.tex, false);
    // KaTeX's nested, offset boxes confuse CodeMirror's click mapping; place the cursor directly.
    span.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || view.state.readOnly) return;
      event.preventDefault();
      let pos: number;
      try { pos = view.posAtDOM(span); } catch { return; }
      view.dispatch({ selection: { anchor: pos + 1 }, userEvent: 'select.pointer' });
      view.focus();
    });
    return span;
  }
  ignoreEvent(): boolean { return false; }
}

// ---------------------------------------------------------------- block decorations

function headings(state: EditorState): TocEntry[] {
  const result: TocEntry[] = [];
  syntaxTree(state).topNode.cursor().iterate((node) => {
    const match = /^(ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!match) return node.name === 'Document';
    const raw = state.sliceDoc(node.from, node.to);
    const text = match[1] === 'ATX' ? raw.replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '') : raw.split('\n')[0];
    result.push({ level: Number(match[2]), text: text.replace(/[*_`~]/g, '').trim(), pos: node.from });
    return false;
  });
  return result;
}

function fenceInfo(state: EditorState, node: SyntaxNode): { lang: string; code: string } | null {
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  const fence = /^\s*(`{3,}|~{3,})/.exec(first.text);
  if (!fence || first.number === last.number) return null;
  // An unclosed fence runs to the end of the document; leave it as editable text.
  if (!last.text.trim().startsWith(fence[1])) return null;
  const lang = first.text.slice(fence.index + fence[0].length).trim().split(/\s+/)[0].toLowerCase();
  return { lang, code: state.sliceDoc(state.doc.line(first.number + 1).from, Math.max(last.from - 1, first.to)) };
}

/** Start of the table currently shown as Markdown source, or -1. */
const tableSourceField = StateField.define<number>({
  create: () => -1,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(showTableSource)) return e.value;
    if (value < 0) return value;
    const pos = tr.changes.mapPos(value, -1);
    const tree = syntaxTree(tr.state);
    const node = tree.resolveInner(Math.min(pos + 1, tr.state.doc.length), 1);
    let table: { from: number; to: number } | null = null;
    for (let n: typeof node | null = node; n; n = n.parent) if (n.name === 'Table') { table = n; break; }
    const head = tr.state.selection.main.head;
    // Leaving the table (or losing focus) turns it back into a grid.
    if (!table || head < table.from || head > tr.state.doc.lineAt(table.to).to) return -1;
    if (tr.effects.some((e) => e.is(setFocus) && !e.value)) return -1;
    return tr.state.doc.lineAt(table.from).from;
  },
});

function buildBlocks(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const tocEntries = () => headings(state);
  /** Rendered widget, or (while the cursor is inside) the source with an optional live preview under it. */
  const block = (from: number, to: number, widget: WidgetType, preview?: () => WidgetType, boxLines = false) => {
    if (!touches(state, from, to)) {
      ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
      return;
    }
    if (boxLines) {
      const first = doc.lineAt(from).number;
      const last = doc.lineAt(to).number;
      for (let n = first; n <= last; n++) {
        const cls = `md-code-line md-src-line${n === first ? ' md-code-first' : ''}${n === last ? ' md-code-last' : ''}`;
        ranges.push(Decoration.line({ class: cls }).range(doc.line(n).from));
      }
    }
    if (preview) ranges.push(Decoration.widget({ widget: preview(), block: true, side: 1 }).range(to));
  };

  const top = syntaxTree(state).topNode;
  let skipUntil = -1;
  for (let node = top.firstChild; node; node = node.nextSibling) {
    if (node.from < skipUntil) continue;
    const from = doc.lineAt(node.from).from;
    const to = doc.lineAt(node.to).to;

    if (node.name === 'FencedCode') {
      const info = fenceInfo(state, node);
      if (!info) continue;
      if (info.lang === 'mermaid') block(from, to, new MermaidWidget(info.code), () => new MermaidPreviewWidget(info.code));
      else if (info.lang === 'math' || info.lang === 'latex' || info.lang === 'katex') block(from, to, new MathWidget(info.code), () => new MathPreviewWidget(info.code));
      else block(from, to, new CodeWidget(info.code, info.lang));
    } else if (node.name === 'Table') {
      // Tables are always interactive grids, except right after "Edit as Markdown".
      if (state.field(tableSourceField) !== from) {
        ranges.push(Decoration.replace({ widget: new TableWidget(state.sliceDoc(from, to), state.readOnly), block: true }).range(from, to));
      }
    } else if (node.name === 'Paragraph') {
      const text = state.sliceDoc(from, to);
      if (/^\[\[?toc\]\]?$/i.test(text.trim())) {
        block(from, to, new TocWidget(tocEntries()), () => new TocWidget(tocEntries(), true));
        continue;
      }
      const container = new RegExp(`^:::\\s*(${CONTAINER_TYPES.join('|')})\\b`, 'i').exec(doc.lineAt(from).text);
      if (container) {
        // Containers may span several paragraphs; find the closing ":::" line.
        let end = -1;
        for (let n = doc.lineAt(from).number + 1; n <= doc.lines; n++) {
          if (doc.line(n).text.trim() === ':::') { end = doc.line(n).to; break; }
        }
        if (end > 0) {
          block(from, end, new HtmlWidget(state.sliceDoc(from, end), ''));
          skipUntil = end;
          continue;
        }
      }
      const math = /^\s*\$\$([\s\S]*?)\$\$\s*$/.exec(text);
      if (math && math[1].trim()) {
        const tex = math[1].trim();
        block(from, to, new MathWidget(tex), () => new MathPreviewWidget(tex), true);
      }
    }
  }
  return Decoration.set(ranges, true);
}

const blockField = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(value, tr: Transaction) {
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    if (tr.docChanged || tr.selection || treeChanged || tr.effects.some((e) => e.is(setFocus) || e.is(refreshLive) || e.is(showTableSource))) return buildBlocks(tr.state);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------- inline decorations

const hide = Decoration.replace({ replace: true });
const mark = (className: string) => Decoration.mark({ class: className });
const lineClass = (className: string) => Decoration.line({ class: className });

function insideBlock(blocks: DecorationSet, pos: number): boolean {
  let inside = false;
  blocks.between(pos, pos, (from, to) => { if (from <= pos && to >= pos) inside = true; });
  return inside;
}

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const blocks = state.field(blockField);
  const ranges: Range<Decoration>[] = [];
  const noMath: Array<[number, number]> = [];
  const tree = syntaxTree(state);
  /** Line decorations by line start; nested items overwrite their parents. */
  const listLines = new Map<number, Decoration>();
  /** Content indent (em) of each open list item, innermost last. */
  const indents: number[] = [];

  /*
   * Hanging indent: the marker sits in a fixed-width box and wrapped lines align with the
   * text after it. Leading spaces are hidden; the indent comes from padding instead.
   */
  const listItem = (node: SyntaxNode) => {
    const line = state.doc.lineAt(node.from);
    const markNode = node.getChild('ListMark');
    const parentIndent = indents.length ? indents[indents.length - 1] : 0;
    if (!markNode) { indents.push(parentIndent); return; }
    const ordered = node.parent?.name === 'OrderedList';
    const markText = state.sliceDoc(markNode.from, markNode.to);
    const task = node.getChild('Task')?.getChild('TaskMarker') ?? null;
    const width = task ? 1.5 : ordered ? Math.max(1.6, 0.6 * markText.length + 0.5) : 1.3;
    const indent = parentIndent + width;
    indents.push(indent);
    const lead = state.sliceDoc(line.from, markNode.from);
    if (!/^[ \t]*$/.test(lead)) {
      // Inside a blockquote or similar: no hanging indent, just render the marker.
      if (task && !touches(state, markNode.from, task.to)) {
        ranges.push(Decoration.replace({ replace: true, widget: new CheckboxWidget(/x/i.test(state.sliceDoc(task.from, task.to))) }).range(markNode.from, task.to));
      }
      return;
    }
    const prefixEnd = task ? task.to : markNode.to;
    const after = state.sliceDoc(prefixEnd, prefixEnd + 1) === ' ' ? prefixEnd + 1 : prefixEnd;
    const style = `--md-li-indent:${indent}em;--md-li-mark:${width}em`;
    listLines.set(line.from, Decoration.line({ class: 'md-li', attributes: { style } }));
    if (lead) ranges.push(hide.range(line.from, markNode.from));
    if (touches(state, markNode.from, after)) {
      ranges.push(mark('md-list-marker md-list-source').range(markNode.from, after));
    } else if (task) {
      const checked = /x/i.test(state.sliceDoc(task.from, task.to));
      ranges.push(Decoration.replace({ replace: true, widget: new CheckboxWidget(checked) }).range(markNode.from, after));
      if (checked && after < line.to) ranges.push(mark('md-task-done').range(after, line.to));
    } else {
      const glyph = ordered ? markText : ['•', '◦', '▪'][Math.min(2, indents.length - 1)];
      ranges.push(Decoration.replace({ replace: true, widget: new MarkerWidget(glyph, ordered ? 'md-list-num' : 'md-list-bullet') }).range(markNode.from, after));
    }
    // Continuation lines of this item align with its text.
    const cut = markNode.from - line.from + (after - markNode.from);
    for (let n = line.number + 1; n <= state.doc.lineAt(node.to).number; n++) {
      const l = state.doc.line(n);
      listLines.set(l.from, Decoration.line({ class: 'md-li-cont', attributes: { style } }));
      const spaces = /^[ \t]*/.exec(l.text)![0].length;
      if (spaces && l.length > 0) ranges.push(hide.range(l.from, l.from + Math.min(spaces, cut)));
    }
  };

  for (const { from, to } of view.visibleRanges) {
    indents.length = 0;
    tree.iterate({
      from,
      to,
      leave: (ref) => { if (ref.name === 'ListItem') indents.pop(); },
      enter: (ref) => {
        const node = ref.node;
        const name = node.name;
        if (insideBlock(blocks, node.from)) return false;

        const heading = /^(ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          ranges.push(lineClass(`md-h md-h${heading[2]}`).range(state.doc.lineAt(node.from).from));
          if (heading[1] === 'Setext') {
            const second = state.doc.lineAt(node.to);
            if (!lineTouches(state, node.from) && second.number > state.doc.lineAt(node.from).number) {
              ranges.push(lineClass('md-setext-underline').range(second.from));
            }
          }
          return;
        }

        switch (name) {
          case 'HeaderMark': {
            const parent = node.parent!;
            if (parent.name.startsWith('ATX') && !touches(state, parent.from, parent.to)) {
              const after = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
              ranges.push(hide.range(node.from, Math.min(after, parent.to)));
            }
            return;
          }
          case 'Emphasis': case 'StrongEmphasis': case 'Strikethrough': case 'InlineCode': {
            const cls = { Emphasis: 'md-em', StrongEmphasis: 'md-strong', Strikethrough: 'md-strike', InlineCode: 'md-inline-code' }[name];
            ranges.push(mark(cls).range(node.from, node.to));
            if (name === 'InlineCode') noMath.push([node.from, node.to]);
            if (!touches(state, node.from, node.to)) {
              for (let child = node.firstChild; child; child = child.nextSibling) {
                if (child.name === 'EmphasisMark' || child.name === 'StrikethroughMark' || child.name === 'CodeMark') {
                  ranges.push(hide.range(child.from, child.to));
                }
              }
            }
            return;
          }
          case 'Link': {
            noMath.push([node.from, node.to]);
            const text = state.sliceDoc(node.from, node.to);
            const url = node.getChild('URL');
            const href = url ? state.sliceDoc(url.from, url.to) : '';
            if (text.startsWith('[^')) {
              // Footnote reference or definition label: show just the label, superscripted.
              const close = text.indexOf(']');
              if (close > 2 && !touches(state, node.from, node.to)) {
                ranges.push(hide.range(node.from, node.from + 2));
                ranges.push(mark('md-footnote-ref').range(node.from + 2, node.from + close));
                ranges.push(hide.range(node.from + close, node.from + close + 1));
              } else {
                ranges.push(mark('md-footnote-ref').range(node.from, node.to));
              }
              return false;
            }
            const marks = node.getChildren('LinkMark');
            if (marks.length >= 2) {
              ranges.push(Decoration.mark({ class: 'md-link', attributes: { 'data-href': href } }).range(marks[0].to, marks[1].from));
              if (!touches(state, node.from, node.to)) {
                ranges.push(hide.range(marks[0].from, marks[0].to));
                ranges.push(hide.range(marks[1].from, node.to));
              }
            }
            return false;
          }
          case 'Image': {
            noMath.push([node.from, node.to]);
            const url = node.getChild('URL');
            if (url && !touches(state, node.from, node.to)) {
              const alt = /^!\[([^\]]*)\]/.exec(state.sliceDoc(node.from, node.to))?.[1] ?? '';
              ranges.push(Decoration.replace({ replace: true, widget: new ImageWidget(state.sliceDoc(url.from, url.to), alt) }).range(node.from, node.to));
            }
            return false;
          }
          case 'Autolink': {
            noMath.push([node.from, node.to]);
            const url = node.getChild('URL');
            if (url) ranges.push(Decoration.mark({ class: 'md-link', attributes: { 'data-href': state.sliceDoc(url.from, url.to) } }).range(url.from, url.to));
            if (url && !touches(state, node.from, node.to)) {
              ranges.push(hide.range(node.from, url.from));
              ranges.push(hide.range(url.to, node.to));
            }
            return false;
          }
          case 'URL': {
            noMath.push([node.from, node.to]);
            ranges.push(Decoration.mark({ class: 'md-link', attributes: { 'data-href': state.sliceDoc(node.from, node.to) } }).range(node.from, node.to));
            return;
          }
          case 'Blockquote': {
            for (let pos = node.from; pos <= node.to;) {
              const line = state.doc.lineAt(pos);
              ranges.push(lineClass('md-quote-line').range(line.from));
              pos = line.to + 1;
            }
            return;
          }
          case 'QuoteMark': {
            if (!lineTouches(state, node.from)) {
              const after = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
              ranges.push(hide.range(node.from, after));
            }
            return;
          }
          case 'ListItem': {
            listItem(node);
            return;
          }
          case 'ListMark': case 'TaskMarker':
            return; // Handled by ListItem.
          case 'HorizontalRule': {
            if (!lineTouches(state, node.from)) ranges.push(Decoration.replace({ replace: true, widget: new TextWidget('', 'md-hr') }).range(node.from, node.to));
            return;
          }
          case 'FencedCode': case 'CodeBlock': {
            noMath.push([node.from, node.to]);
            const first = state.doc.lineAt(node.from).number;
            const last = state.doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) {
              // Fence lines are dimmed; first/last get the block's rounded padding.
              const fence = name === 'FencedCode' && (n === first || n === last);
              const cls = `md-code-line${fence ? ' md-code-fence' : ''}${n === first ? ' md-code-first' : ''}${n === last ? ' md-code-last' : ''}`;
              ranges.push(lineClass(cls).range(state.doc.line(n).from));
            }
            return false;
          }
          case 'Table': {
            for (let pos = node.from; pos <= node.to;) {
              const line = state.doc.lineAt(pos);
              ranges.push(lineClass('md-code-line').range(line.from));
              pos = line.to + 1;
            }
            return;
          }
          case 'HTMLBlock': case 'HTMLTag': case 'Comment': case 'ProcessingInstruction': {
            noMath.push([node.from, node.to]);
            return false;
          }
          case 'LinkReference': {
            ranges.push(mark('md-dim').range(node.from, node.to));
            return false;
          }
        }
        return;
      },
    });

    // Inline math: $...$ outside code, links and HTML.
    const text = state.sliceDoc(from, to);
    const re = /(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?![$\d])/g;
    for (let m: RegExpExecArray | null; (m = re.exec(text));) {
      const start = from + m.index;
      const end = start + m[0].length;
      if (noMath.some(([a, b]) => start < b && end > a) || insideBlock(blocks, start)) continue;
      if (touches(state, start, end)) ranges.push(mark('md-math-source').range(start, end));
      else ranges.push(Decoration.replace({ replace: true, widget: new InlineMathWidget(m[1]) }).range(start, end));
    }
  }
  for (const [pos, deco] of listLines) ranges.push(deco.range(pos));
  return dropOverlaps(ranges);
}

/** Replace decorations may not overlap; keep the first (outermost) one. */
function dropOverlaps(ranges: Range<Decoration>[]): DecorationSet {
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const result: Range<Decoration>[] = [];
  let replacedTo = -1;
  for (const range of ranges) {
    if (range.value.spec.replace) {
      if (range.from < replacedTo) continue;
      replacedTo = range.to;
    }
    result.push(range);
  }
  return Decoration.set(result, true);
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildInline(view); }
    update(update: ViewUpdate) {
      if (
        update.docChanged || update.viewportChanged || update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setFocus) || e.is(refreshLive)))
      ) {
        this.decorations = buildInline(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

const focusTracker = EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing));

/** Last mousedown position, to tell which side of a table a click was on. */
let lastPointerY = 0;
const pointerTracker = EditorView.domEventHandlers({
  mousedown(event) { lastPointerY = event.clientY; return false; },
});

/** Monospace character width for mapping a click in a rendered code block to a column. */
let measureCanvas: HTMLCanvasElement | undefined;
function charWidth(el: HTMLElement): number {
  measureCanvas ??= document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d')!;
  const style = getComputedStyle(el);
  ctx.font = `${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText('0').width || 8;
}

/** Where the cursor goes when a rendered block is clicked: inside its source, near the click. */
function revealPos(view: EditorView, block: HTMLElement, event: MouseEvent): number | null {
  let start: number;
  try { start = view.posAtDOM(block); } catch { return null; }
  const doc = view.state.doc;
  const first = doc.lineAt(start);
  const firstText = first.text.trim();
  if (block.matches('.md-code')) {
    const code = block.querySelector('code') ?? block;
    const rect = code.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(code).lineHeight) || 20;
    let last = first.number + 1;
    while (last < doc.lines && !/^\s*(`{3,}|~{3,})\s*$/.test(doc.line(last).text)) last++;
    const n = Math.min(Math.max(first.number + 1 + Math.floor((event.clientY - rect.top) / lineHeight), first.number + 1), Math.max(first.number + 1, last - 1));
    if (n > doc.lines) return first.to;
    const line = doc.line(n);
    const col = Math.max(0, Math.round((event.clientX - rect.left + (block.scrollLeft || 0)) / charWidth(code)));
    return line.from + Math.min(col, line.length);
  }
  if (block.matches('.md-math') && firstText === '$$' && first.number < doc.lines) return doc.line(first.number + 1).from;
  if (block.matches('.md-math')) {
    const offset = first.text.indexOf('$$');
    if (offset >= 0) return first.from + offset + 2;
  }
  // Fenced blocks (math, Mermaid) and containers: start of the first content line.
  if (/^\s*(`{3,}|~{3,}|:::)/.test(first.text) && first.number < doc.lines) return doc.line(first.number + 1).from;
  return first.to;
}

/**
 * Clicking a rendered block (code, math, diagram, container) opens its source with the
 * cursor at the click, wherever in the block the click lands. Tables handle their own clicks.
 */
const blockClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement;
    const block = target.closest<HTMLElement>('.md-live-block');
    if (!block || block.matches('.md-grid') || event.button !== 0) return false;
    // The live preview under the source being edited: keep the cursor where it is.
    if (block.matches('.md-src-preview')) {
      if (!target.closest('.md-toc a')) event.preventDefault();
      return true;
    }
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (link && (event.metaKey || event.ctrlKey || view.state.readOnly)) {
      event.preventDefault();
      context.openLink(link.getAttribute('href')!);
      return true;
    }
    if (view.state.readOnly) return false;
    if (target.closest('.md-toc a')) return false;
    // Formulas, diagrams and the table of contents change height a lot when opened, so by
    // default they open on a double click; a single click leaves the page as it is.
    if (block.matches('.md-math, .md-mermaid, .md-toc-block') && context.blockEdit() === 'doubleClick' && event.detail < 2) {
      event.preventDefault();
      return true;
    }
    const pos = revealPos(view, block, event);
    if (pos === null) return false;
    event.preventDefault();
    view.focus();
    view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
    // A tall diagram collapses to a few source lines that may end up outside the view: bring them in.
    requestAnimationFrame(() => view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 48 }) }));
    return true;
  },
});

/** The table grid widget whose range contains `pos`, if any. */
function tableAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  state.field(blockField).between(pos, pos, (from, to, value) => {
    if (value.spec.widget instanceof TableWidget && pos >= from && pos <= to) found = { from, to };
  });
  return found;
}

/**
 * The cursor never rests on a table grid's source. Keyboard moves onto it focus a cell; a click
 * that maps onto it without hitting a cell goes to the line just above or below the table.
 */
const tableEntry = EditorView.updateListener.of((update) => {
  if (!update.selectionSet || update.docChanged || !update.view.hasFocus) return;
  const head = update.state.selection.main;
  if (!head.empty) return;
  const table = tableAt(update.state, head.head);
  if (!table) return;
  const { from, to } = table as { from: number; to: number };
  if (update.transactions.some((tr) => tr.isUserEvent('select.pointer'))) {
    const dom = gridAt(update.view, from);
    const rect = dom?.getBoundingClientRect();
    const above = !rect || !lastPointerY || lastPointerY < rect.top + rect.height / 2;
    const doc = update.state.doc;
    const target = above ? (from > 0 ? from - 1 : null) : (to < doc.length ? to + 1 : null);
    queueMicrotask(() => {
      if (target !== null) update.view.dispatch({ selection: { anchor: target } });
      else if (dom) focusCell(dom, above ? 0 : Number.MAX_SAFE_INTEGER, 0, above ? 'start' : 'end');
    });
    return;
  }
  const fromBelow = update.startState.selection.main.head > to;
  queueMicrotask(() => {
    const dom = gridAt(update.view, from);
    if (dom) focusCell(dom, fromBelow ? Number.MAX_SAFE_INTEGER : 0, 0, fromBelow ? 'end' : 'start');
  });
});

/** Arrow keys that would move across a table grid move into it instead (first row from above, last from below). */
function enterTableVertically(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const target = view.moveVertically(sel, forward);
  const [lo, hi] = forward ? [sel.head, target.head] : [target.head, sel.head];
  let hit: { from: number; to: number } | null = null;
  state.field(blockField).between(lo, hi, (from, to, value) => {
    if (!(value.spec.widget instanceof TableWidget)) return;
    // The table must lie in the direction of travel, not under the current cursor.
    if (forward ? from >= state.doc.lineAt(sel.head).to : to <= state.doc.lineAt(sel.head).from) {
      if (!hit || (forward ? from < hit.from : from > hit.from)) hit = { from, to };
    }
  });
  if (!hit) return false;
  const dom = gridAt(view, (hit as { from: number }).from);
  if (!dom) return false;
  focusCell(dom, forward ? 0 : Number.MAX_SAFE_INTEGER, 0, forward ? 'start' : 'end');
  return true;
}

/** Backspace/Delete next to a table move into it instead of merging lines into its rows. */
const tableKeys = Prec.high(keymap.of([
  { key: 'ArrowDown', run: (view) => enterTableVertically(view, true) },
  { key: 'ArrowUp', run: (view) => enterTableVertically(view, false) },
  {
    key: 'Backspace',
    run: (view) => {
      const { state } = view;
      const sel = state.selection.main;
      const line = state.doc.lineAt(sel.head);
      if (!sel.empty || sel.head !== line.from || line.number === 1) return false;
      const table = tableAt(state, line.from - 1);
      if (!table) return false;
      const nextBlank = line.number === state.doc.lines || !state.doc.line(line.number + 1).text.trim();
      if (!line.text && nextBlank) view.dispatch({ changes: { from: line.from - 1, to: line.from } });
      const dom = gridAt(view, table.from);
      if (dom) focusCell(dom, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'end');
      return true;
    },
  },
  {
    key: 'Delete',
    run: (view) => {
      const { state } = view;
      const sel = state.selection.main;
      const line = state.doc.lineAt(sel.head);
      if (!sel.empty || sel.head !== line.to || line.number === state.doc.lines) return false;
      const table = tableAt(state, line.to + 1);
      if (!table) return false;
      const prevBlank = line.number === 1 || !state.doc.line(line.number - 1).text.trim();
      if (!line.text && prevBlank) view.dispatch({ changes: { from: line.from, to: line.to + 1 } });
      const dom = gridAt(view, view.state.doc.lineAt(table.from - (line.text || !prevBlank ? 0 : line.length + 1)).from);
      if (dom) focusCell(dom, 0, 0, 'start');
      return true;
    },
  },
]));

export function livePreview(ctx: LiveContext): Extension {
  context = ctx;
  setTableHooks({ renderInline: (text) => ctx.renderInline(text), openLink: (href) => ctx.openLink(href) });
  return [
    focusField, focusTracker, tableSourceField, blockField, inlinePlugin, pointerTracker, tableEntry, tableKeys, blockClicks,
    EditorView.editorAttributes.of({ class: 'md-live' }),
  ];
}

export const syncFocus = (view: EditorView) => view.dispatch({ effects: setFocus.of(view.hasFocus) });
