import { StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Align, applyTableOp, cellEdit, escapeCell, parseTable, serializeTable, TableModel, TableOp } from '../table';
import { MenuItem, openMenu } from './controls';
import { sanitize } from './rich';
import { ownStep } from './editor';
import { t } from './i18n';

/*
 * Live-mode table: a grid of editable cells. Each cell shows rendered inline Markdown and
 * switches to its source while focused. Cell edits replace only that cell's text; structure
 * changes (rows, columns, order, alignment) re-serialize the table. The table's source is
 * shown in the editor only after "Edit as Markdown".
 */

export interface TableHooks {
  renderInline(markdown: string): string;
  openLink(href: string): void;
}

let hooks: TableHooks;
export const setTableHooks = (value: TableHooks) => { hooks = value; };

/** Shows the source of the table starting at `pos` until the cursor leaves it. */
export const showTableSource = StateEffect.define<number>();

interface GridState {
  view: EditorView;
  source: string;
  model: TableModel;
}

const states = new WeakMap<HTMLElement, GridState>();
/** Cell to focus after the next rebuild, keyed by table start position. */
let pendingFocus: { from: number; row: number; col: number; caret: 'start' | 'end' | 'all'; scrollLeft: number } | null = null;
let pointer: { x: number; y: number } | null = null;

export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly readOnly: boolean) { super(); }
  eq(other: TableWidget): boolean { return other.source === this.source && other.readOnly === this.readOnly; }
  get estimatedHeight(): number { return this.source.split('\n').length * 38; }
  ignoreEvent(): boolean { return true; }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'md-grid md-live-block';
    build(dom, view, this.source);
    attach(dom);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (!states.has(dom) || dom.classList.contains('md-grid-readonly') !== this.readOnly) return false;
    patch(dom, view, this.source);
    return true;
  }
}

// ---------------------------------------------------------------- DOM

const ICONS = {
  source: '<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4" />',
  more: '<circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/>',
  grip: '<circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/>',
};
export const icon = (paths: string, cls = '') =>
  `<svg class="md-icon ${cls}" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

function toolButton(name: keyof typeof ICONS, title: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'md-grid-tool';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = icon(ICONS[name], name === 'more' || name === 'grip' ? 'md-icon-fill' : '');
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', onClick);
  return button;
}

function build(dom: HTMLElement, view: EditorView, source: string): void {
  const model = parseTable(source) ?? { rows: [['']], aligns: [null] };
  const readOnly = view.state.readOnly;
  // Rebuilding (e.g. after adding a column) keeps the horizontal scroll position.
  const scrollLeft = dom.querySelector('.md-grid-scroll')?.scrollLeft ?? 0;
  states.set(dom, { view, source, model });
  dom.replaceChildren();
  dom.classList.toggle('md-grid-readonly', readOnly);

  const tools = document.createElement('div');
  tools.className = 'md-grid-tools';
  tools.append(
    toolButton('source', t('Edit as Markdown'), () => editSource(dom)),
    toolButton('more', t('Table actions'), (event) => openTableMenu(dom, event.currentTarget as HTMLElement))
  );

  const scroll = document.createElement('div');
  scroll.className = 'md-grid-scroll';
  const table = document.createElement('table');
  const thead = table.createTHead();
  const tbody = table.createTBody();
  model.rows.forEach((row, r) => {
    const tr = (r === 0 ? thead : tbody).insertRow();
    row.forEach((text, c) => {
      const cell = document.createElement(r === 0 ? 'th' : 'td');
      const align = model.aligns[c];
      if (align) cell.style.textAlign = align;
      const editor = document.createElement('div');
      editor.className = 'md-cell';
      editor.contentEditable = readOnly ? 'false' : 'plaintext-only';
      editor.spellcheck = false;
      editor.dataset.row = String(r);
      editor.dataset.col = String(c);
      editor.dataset.source = text;
      showRendered(editor);
      cell.append(editor);
      if (!readOnly && r === 0) cell.append(grip('col', c));
      if (!readOnly && c === 0 && r > 0) cell.append(grip('row', r));
      tr.append(cell);
    });
  });
  scroll.append(table);
  scroll.addEventListener('scroll', () => updateShadows(scroll), { passive: true });
  // The box is as wide as the table, so the buttons can sit just outside its top-right corner.
  const box = document.createElement('div');
  box.className = 'md-grid-box';
  box.append(...(readOnly ? [] : [tools]), scroll);
  dom.append(box);
  scroll.scrollLeft = scrollLeft;
  requestAnimationFrame(() => updateShadows(scroll));
}

/** Puts the buttons right of the table's top-right corner, or above it when there is no room. */
function placeTools(dom: HTMLElement): void {
  const box = dom.querySelector<HTMLElement>('.md-grid-box');
  const tools = dom.querySelector<HTMLElement>('.md-grid-tools');
  const scroller = states.get(dom)?.view.scrollDOM;
  if (!box || !tools || !scroller) return;
  const room = scroller.getBoundingClientRect().right - box.getBoundingClientRect().right;
  tools.classList.toggle('md-grid-tools-above', room < 34);
}

/** Event handlers, attached once per widget DOM (rebuilds only replace its content). */
function attach(dom: HTMLElement): void {
  const view = () => states.get(dom)!.view;
  dom.addEventListener('pointerenter', () => placeTools(dom));
  dom.addEventListener('mousedown', (event) => {
    pointer = { x: event.clientX, y: event.clientY };
    const target = event.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>('a[href]');
    if (link && (event.metaKey || event.ctrlKey || view().state.readOnly)) {
      event.preventDefault();
      hooks.openLink(link.getAttribute('href')!);
      return;
    }
    // Only cells, handles and buttons react; the space around the table does nothing.
    if (!target.closest('.md-cell, .md-grip, .md-grid-tool')) event.preventDefault();
  });
  dom.addEventListener('focusin', (event) => {
    placeTools(dom);
    const cell = cellOf(event.target);
    if (cell) startEditing(cell);
  });
  dom.addEventListener('focusout', (event) => {
    const cell = cellOf(event.target);
    if (cell && !cell.contains(event.relatedTarget as Node)) stopEditing(dom, cell);
  });
  dom.addEventListener('input', (event) => {
    const cell = cellOf(event.target);
    if (cell && !(event as InputEvent).isComposing) commit(dom, cell);
  });
  dom.addEventListener('compositionend', (event) => {
    const cell = cellOf(event.target);
    if (cell) commit(dom, cell);
  });
  dom.addEventListener('paste', (event) => {
    if (!cellOf(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/\s*\r?\n\s*/g, ' ');
    document.execCommand('insertText', false, text);
  });
  dom.addEventListener('drop', (event) => event.preventDefault());
  dom.addEventListener('keydown', (event) => onKey(dom, event));
  dom.addEventListener('contextmenu', (event) => {
    const cell = cellOf(event.target);
    if (!cell || view().state.readOnly) return;
    event.preventDefault();
    openCellMenu(dom, cell, { x: event.clientX, y: event.clientY });
  });
}

/** Updates the grid in place after a document change, keeping the focused cell untouched. */
function patch(dom: HTMLElement, view: EditorView, source: string): void {
  const state = states.get(dom)!;
  const model = parseTable(source);
  const old = state.model;
  if (!model || model.rows.length !== old.rows.length || model.aligns.length !== old.aligns.length || model.aligns.some((a, i) => a !== old.aligns[i])) {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && dom.contains(active) ? cellPos(active) : null;
    build(dom, view, source);
    if (focused) focusCell(dom, focused.row, focused.col, 'end');
    return;
  }
  states.set(dom, { view, source, model });
  for (const cell of dom.querySelectorAll<HTMLElement>('.md-cell')) {
    const { row, col } = cellPos(cell);
    const text = model.rows[row][col];
    if (cell.dataset.source === text) continue;
    cell.dataset.source = text;
    if (cell.dataset.editing) {
      // Changed from outside (undo, external edit) while editing: show the new text.
      if (escapeCell(cell.textContent ?? '').trim() !== text) { cell.textContent = text; placeCaret(cell, 'end'); }
    } else {
      showRendered(cell);
    }
  }
}

function grip(kind: 'row' | 'col', index: number): HTMLElement {
  const handle = document.createElement('span');
  handle.className = `md-grip md-grip-${kind}`;
  handle.contentEditable = 'false';
  handle.title = kind === 'row' ? t('Drag to move row') : t('Drag to move column');
  handle.innerHTML = icon(ICONS.grip, 'md-icon-fill');
  handle.dataset.index = String(index);
  handle.addEventListener('pointerdown', (event) => startDrag(event, handle, kind, index));
  return handle;
}

function updateShadows(scroll: HTMLElement): void {
  const max = scroll.scrollWidth - scroll.clientWidth;
  scroll.classList.toggle('md-scroll-left', scroll.scrollLeft > 1);
  scroll.classList.toggle('md-scroll-right', max > 1 && scroll.scrollLeft < max - 1);
}

const cellOf = (target: EventTarget | null) =>
  target instanceof HTMLElement ? target.closest<HTMLElement>('.md-cell') : null;
const cellPos = (cell: HTMLElement) => {
  const el = cell.closest<HTMLElement>('.md-cell') ?? cell;
  return { row: Number(el.dataset.row), col: Number(el.dataset.col) };
};

function showRendered(cell: HTMLElement): void {
  const text = cell.dataset.source ?? '';
  cell.innerHTML = text ? sanitize(hooks.renderInline(text)) : '';
}

function startEditing(cell: HTMLElement): void {
  if (cell.dataset.editing) return;
  cell.dataset.editing = '1';
  const rendered = cell.innerHTML;
  cell.textContent = cell.dataset.source ?? '';
  // Place the caret where the user clicked, approximately, now that the source is shown.
  if (pointer && rendered && document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(pointer.x, pointer.y);
    if (range && cell.contains(range.startContainer)) {
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      placeCaret(cell, 'end');
    }
  }
  pointer = null;
}

function stopEditing(dom: HTMLElement, cell: HTMLElement): void {
  if (!cell.dataset.editing || !cell.isConnected) return;
  commit(dom, cell);
  delete cell.dataset.editing;
  showRendered(cell);
}

function placeCaret(cell: HTMLElement, where: 'start' | 'end' | 'all'): void {
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (where !== 'all') range.collapse(where === 'start');
  const selection = getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

export function focusCell(dom: HTMLElement, row: number, col: number, caret: 'start' | 'end' | 'all' = 'end'): void {
  const state = states.get(dom);
  if (!state) return;
  const r = Math.max(0, Math.min(state.model.rows.length - 1, row));
  const c = Math.max(0, Math.min(state.model.aligns.length - 1, col));
  const cell = dom.querySelector<HTMLElement>(`.md-cell[data-row="${r}"][data-col="${c}"]`);
  if (!cell) return;
  pointer = null;
  cell.focus({ preventScroll: true });
  placeCaret(cell, caret);
  cell.closest('td, th')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** Finds the table's current range in the document from its DOM. */
function locate(dom: HTMLElement): { from: number; to: number } | null {
  const view = states.get(dom)?.view;
  if (!view || !dom.isConnected) return null;
  let pos: number;
  try { pos = view.posAtDOM(dom); } catch { return null; }
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);
  for (const p of [pos, pos + 1]) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(Math.min(p, doc.length), 1); node; node = node.parent) {
      if (node.name === 'Table') return { from: doc.lineAt(node.from).from, to: doc.lineAt(node.to).to };
    }
  }
  return null;
}

function commit(dom: HTMLElement, cell: HTMLElement): void {
  const state = states.get(dom);
  const range = locate(dom);
  if (!state || !range) return;
  const { row, col } = cellPos(cell);
  const value = escapeCell(cell.textContent ?? '').trim();
  const text = state.view.state.sliceDoc(range.from, range.to);
  const change = cellEdit(text, row, col, value);
  if (!change) return;
  cell.dataset.source = value;
  state.view.dispatch({
    changes: { from: range.from + change.from, to: range.from + change.to, insert: change.insert },
    userEvent: 'input.table',
  });
}

/** Applies a structural change and focuses the given cell afterwards. */
export function applyOp(dom: HTMLElement, op: TableOp | 'deleteTable', focus?: { row: number; col: number }): void {
  const state = states.get(dom);
  const range = locate(dom);
  if (!state || !range) return;
  const { view } = state;
  // Flush the cell being edited first so its text is part of the new table.
  const active = document.activeElement;
  if (active instanceof HTMLElement && dom.contains(active)) {
    const cell = cellOf(active);
    if (cell) commit(dom, cell);
  }
  const current = locate(dom) ?? range;
  if (op === 'deleteTable') {
    const doc = view.state.doc;
    const to = current.to < doc.length ? current.to + 1 : current.to;
    view.dispatch({ changes: { from: current.from, to }, selection: { anchor: current.from }, userEvent: 'delete.table', annotations: ownStep });
    view.focus();
    return;
  }
  const model = parseTable(view.state.sliceDoc(current.from, current.to));
  if (!model) return;
  const next = applyTableOp(model, op);
  if (next === model) return;
  pendingFocus = focus ? { from: current.from, ...focus, caret: 'end', scrollLeft: dom.querySelector('.md-grid-scroll')?.scrollLeft ?? 0 } : null;
  view.dispatch({ changes: { from: current.from, to: current.to, insert: serializeTable(next) }, userEvent: 'input.table', annotations: ownStep });
  restoreFocus(view);
}

/** Focuses the pending cell in the (possibly rebuilt) grid at the remembered position. */
function restoreFocus(view: EditorView): void {
  const target = pendingFocus;
  pendingFocus = null;
  if (!target) return;
  const dom = gridAt(view, target.from);
  if (!dom) return;
  // Keep the horizontal position, then scroll only as far as needed to show the focused cell.
  const scroll = dom.querySelector<HTMLElement>('.md-grid-scroll');
  if (scroll) scroll.scrollLeft = target.scrollLeft;
  focusCell(dom, target.row, target.col, target.caret);
}

export function gridAt(view: EditorView, from: number): HTMLElement | null {
  for (const dom of view.contentDOM.querySelectorAll<HTMLElement>('.md-grid')) {
    try { if (view.state.doc.lineAt(view.posAtDOM(dom)).from === from) return dom; } catch { /* detached */ }
  }
  return null;
}

/** Moves the editor cursor out of the table, adding an empty line at the document edge if needed. */
function leave(dom: HTMLElement, where: 'before' | 'after'): void {
  const state = states.get(dom);
  const range = locate(dom);
  if (!state || !range) return;
  const { view } = state;
  const doc = view.state.doc;
  if (where === 'after') {
    if (range.to >= doc.length) view.dispatch({ changes: { from: doc.length, insert: '\n' }, selection: { anchor: doc.length + 1 } });
    else view.dispatch({ selection: { anchor: range.to + 1 }, scrollIntoView: true });
  } else if (range.from === 0) {
    view.dispatch({ changes: { from: 0, insert: '\n' }, selection: { anchor: 0 } });
  } else {
    view.dispatch({ selection: { anchor: range.from - 1 }, scrollIntoView: true });
  }
  view.focus();
}

function editSource(dom: HTMLElement): void {
  const state = states.get(dom);
  const range = locate(dom);
  if (!state || !range) return;
  state.view.dispatch({ effects: showTableSource.of(range.from), selection: { anchor: range.from }, scrollIntoView: true });
  state.view.focus();
}

// ---------------------------------------------------------------- keyboard

function caretAtEdge(cell: HTMLElement, edge: 'start' | 'end'): boolean {
  const selection = getSelection();
  if (!selection || !selection.isCollapsed || !selection.rangeCount) return false;
  const range = document.createRange();
  range.selectNodeContents(cell);
  const point = selection.getRangeAt(0);
  if (edge === 'start') range.setEnd(point.startContainer, point.startOffset);
  else range.setStart(point.endContainer, point.endOffset);
  return range.toString().length === 0;
}

function wrapSelection(dom: HTMLElement, cell: HTMLElement, mark: string): void {
  const selection = getSelection();
  if (!selection?.rangeCount) return;
  const text = selection.toString();
  document.execCommand('insertText', false, mark + text + mark);
  if (!text) {
    // Put the caret between the marks.
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset - mark.length;
    if (node.nodeType === Node.TEXT_NODE && offset >= 0) {
      range.setStart(node, offset);
      range.collapse(true);
    }
  }
  commit(dom, cell);
}

function onKey(dom: HTMLElement, event: KeyboardEvent): void {
  const cell = cellOf(event.target);
  const state = states.get(dom);
  if (!cell || !state || event.isComposing) return;
  const { row, col } = cellPos(cell);
  const rows = state.model.rows.length;
  const cols = state.model.aligns.length;
  const mod = event.metaKey || event.ctrlKey;
  const handled = () => { event.preventDefault(); event.stopPropagation(); };

  if (event.key === 'Tab' && !mod && !event.altKey) {
    handled();
    if (event.shiftKey) {
      if (col > 0) focusCell(dom, row, col - 1, 'all');
      else if (row > 0) focusCell(dom, row - 1, cols - 1, 'all');
    } else if (col < cols - 1) {
      focusCell(dom, row, col + 1, 'all');
    } else {
      // Tab in the last column adds a column.
      applyOp(dom, { kind: 'insertCol', at: cols }, { row, col: cols });
    }
    return;
  }
  if (event.key === 'Enter' && !event.altKey) {
    handled();
    if (mod) applyOp(dom, { kind: 'insertRow', at: row + 1 }, { row: row + 1, col });
    else if (event.shiftKey) focusCell(dom, row - 1, col, 'end');
    else if (row < rows - 1) focusCell(dom, row + 1, col, 'end');
    // Enter in the last row adds a row.
    else applyOp(dom, { kind: 'insertRow', at: rows }, { row: rows, col });
    return;
  }
  if (event.key === 'Escape') { handled(); leave(dom, 'after'); return; }

  if (event.altKey && event.shiftKey && !mod) {
    const moves: Record<string, () => void> = {
      ArrowUp: () => applyOp(dom, { kind: 'moveRow', from: row, to: row - 1 }, { row: row - 1, col }),
      ArrowDown: () => applyOp(dom, { kind: 'moveRow', from: row, to: row + 1 }, { row: row + 1, col }),
      ArrowLeft: () => applyOp(dom, { kind: 'moveCol', from: col, to: col - 1 }, { row, col: col - 1 }),
      ArrowRight: () => applyOp(dom, { kind: 'moveCol', from: col, to: col + 1 }, { row, col: col + 1 }),
    };
    if (moves[event.key]) { handled(); moves[event.key](); }
    return;
  }
  if (!mod && !event.altKey && !event.shiftKey) {
    if (event.key === 'ArrowUp') { handled(); if (row > 0) focusCell(dom, row - 1, col, 'end'); else leave(dom, 'before'); return; }
    if (event.key === 'ArrowDown') { handled(); if (row < rows - 1) focusCell(dom, row + 1, col, 'end'); else leave(dom, 'after'); return; }
    if (event.key === 'ArrowLeft' && caretAtEdge(cell, 'start')) {
      handled();
      if (col > 0) focusCell(dom, row, col - 1, 'end');
      else if (row > 0) focusCell(dom, row - 1, cols - 1, 'end');
      else leave(dom, 'before');
      return;
    }
    if (event.key === 'ArrowRight' && caretAtEdge(cell, 'end')) {
      handled();
      if (col < cols - 1) focusCell(dom, row, col + 1, 'start');
      else if (row < rows - 1) focusCell(dom, row + 1, 0, 'start');
      else leave(dom, 'after');
      return;
    }
  }
  if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
    // Chrome's own select-all would select the whole editor, not the cell.
    handled();
    placeCaret(cell, 'all');
    return;
  }
  if (mod && !event.altKey && !event.shiftKey) {
    const marks: Record<string, string> = { b: '**', i: '*', e: '`' };
    const mark = marks[event.key.toLowerCase()];
    if (mark) { handled(); wrapSelection(dom, cell, mark); }
  }
}

// ---------------------------------------------------------------- menus

function cellMenu(dom: HTMLElement, row: number, col: number): MenuItem[] {
  const state = states.get(dom)!;
  const rows = state.model.rows.length;
  const cols = state.model.aligns.length;
  const align = state.model.aligns[col];
  const setAlign = (value: Align) => () => applyOp(dom, { kind: 'align', col, align: align === value ? null : value }, { row, col });
  return [
    { label: t('Insert row above'), disabled: row === 0, run: () => applyOp(dom, { kind: 'insertRow', at: row }, { row, col }) },
    { label: t('Insert row below'), shortcut: '⌘↵', run: () => applyOp(dom, { kind: 'insertRow', at: row + 1 }, { row: row + 1, col }) },
    { label: t('Move row up'), shortcut: '⌥⇧↑', disabled: row <= 1, run: () => applyOp(dom, { kind: 'moveRow', from: row, to: row - 1 }, { row: row - 1, col }) },
    { label: t('Move row down'), shortcut: '⌥⇧↓', disabled: row === 0 || row >= rows - 1, run: () => applyOp(dom, { kind: 'moveRow', from: row, to: row + 1 }, { row: row + 1, col }) },
    { label: t('Delete row'), disabled: row === 0, run: () => applyOp(dom, { kind: 'deleteRow', at: row }, { row: Math.min(row, rows - 2), col }) },
    'separator',
    { label: t('Insert column left'), run: () => applyOp(dom, { kind: 'insertCol', at: col }, { row, col }) },
    { label: t('Insert column right'), run: () => applyOp(dom, { kind: 'insertCol', at: col + 1 }, { row, col: col + 1 }) },
    { label: t('Move column left'), shortcut: '⌥⇧←', disabled: col === 0, run: () => applyOp(dom, { kind: 'moveCol', from: col, to: col - 1 }, { row, col: col - 1 }) },
    { label: t('Move column right'), shortcut: '⌥⇧→', disabled: col >= cols - 1, run: () => applyOp(dom, { kind: 'moveCol', from: col, to: col + 1 }, { row, col: col + 1 }) },
    { label: t('Delete column'), disabled: cols <= 1, run: () => applyOp(dom, { kind: 'deleteCol', at: col }, { row, col: Math.min(col, cols - 2) }) },
    'separator',
    { label: t('Align left'), checked: align === 'left', run: setAlign('left') },
    { label: t('Align center'), checked: align === 'center', run: setAlign('center') },
    { label: t('Align right'), checked: align === 'right', run: setAlign('right') },
    'separator',
    { label: t('Edit as Markdown'), run: () => editSource(dom) },
    { label: t('Delete table'), danger: true, run: () => applyOp(dom, 'deleteTable') },
  ];
}

function openCellMenu(dom: HTMLElement, cell: HTMLElement, at: { x: number; y: number }): void {
  const { row, col } = cellPos(cell);
  openMenu(cellMenu(dom, row, col), { x: at.x, y: at.y }, () => cell.isConnected && focusCell(dom, row, col, 'end'));
}

function openTableMenu(dom: HTMLElement, anchor: HTMLElement): void {
  const active = document.activeElement;
  const pos = active instanceof HTMLElement && dom.contains(active) && cellOf(active) ? cellPos(active) : { row: 1, col: 0 };
  const state = states.get(dom)!;
  const row = Math.min(pos.row, state.model.rows.length - 1);
  const rect = anchor.getBoundingClientRect();
  openMenu(cellMenu(dom, row, pos.col), { x: rect.right, y: rect.bottom + 4, alignRight: true });
}

// ---------------------------------------------------------------- drag to reorder

function startDrag(event: PointerEvent, handle: HTMLElement, kind: 'row' | 'col', index: number): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const dom = handle.closest<HTMLElement>('.md-grid')!;
  const scroll = dom.querySelector<HTMLElement>('.md-grid-scroll')!;
  const table = scroll.querySelector('table')!;
  const rows = [...table.rows];
  // Rows are reordered among body rows only; the header stays first.
  const items: HTMLElement[] = kind === 'row' ? rows.slice(1) : [...rows[0].cells];
  const offset = kind === 'row' ? 1 : 0;
  const indicator = document.createElement('div');
  indicator.className = `md-drop md-drop-${kind}`;
  scroll.append(indicator);
  const source = kind === 'row' ? rows[index] : null;
  source?.classList.add('md-dragging');
  if (kind === 'col') for (const r of rows) r.cells[index]?.classList.add('md-dragging');
  dom.classList.add('md-grid-dragging');
  handle.setPointerCapture(event.pointerId);

  let slot = index - offset;
  const update = (e: PointerEvent) => {
    const coord = kind === 'row' ? e.clientY : e.clientX;
    slot = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (coord < (kind === 'row' ? r.top + r.height / 2 : r.left + r.width / 2)) { slot = i; break; }
    }
    const scrollRect = scroll.getBoundingClientRect();
    const edge = slot < items.length ? items[slot].getBoundingClientRect() : items[items.length - 1].getBoundingClientRect();
    if (kind === 'row') {
      const y = (slot < items.length ? edge.top : edge.bottom) - scrollRect.top + scroll.scrollTop;
      indicator.style.cssText = `top:${y - 1}px;left:0;width:${table.offsetWidth}px`;
    } else {
      const x = (slot < items.length ? edge.left : edge.right) - scrollRect.left + scroll.scrollLeft;
      indicator.style.cssText = `left:${x - 1}px;top:0;height:${table.offsetHeight}px`;
      // Keep scrolling while dragging near the edges of a wide table.
      if (e.clientX > scrollRect.right - 24) scroll.scrollLeft += 12;
      else if (e.clientX < scrollRect.left + 24) scroll.scrollLeft -= 12;
    }
  };
  const finish = () => {
    handle.removeEventListener('pointermove', update);
    handle.removeEventListener('pointerup', finish);
    handle.removeEventListener('pointercancel', cancel);
    indicator.remove();
    dom.classList.remove('md-grid-dragging');
    for (const el of dom.querySelectorAll('.md-dragging')) el.classList.remove('md-dragging');
  };
  const cancel = () => finish();
  const drop = () => {
    finish();
    const from = index;
    const target = (slot > index - offset ? slot - 1 : slot) + offset;
    if (target === from) return;
    if (kind === 'row') applyOp(dom, { kind: 'moveRow', from, to: target }, { row: target, col: 0 });
    else applyOp(dom, { kind: 'moveCol', from, to: target }, { row: 0, col: target });
  };
  handle.addEventListener('pointermove', update);
  handle.addEventListener('pointerup', drop, { once: true });
  handle.addEventListener('pointercancel', cancel, { once: true });
  update(event);
}
