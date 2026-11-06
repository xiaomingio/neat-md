/*
 * GFM table model used by the Live table grid. Parsing keeps cell offsets so a cell edit
 * replaces only that cell's text; structural operations re-serialize the table.
 */

export type Align = 'left' | 'center' | 'right' | null;

export interface CellSpan {
  /** Trimmed cell source. */
  text: string;
  /** Offsets of the trimmed text within the line. */
  from: number;
  to: number;
  /** Offsets of the whole segment between pipes. */
  segFrom: number;
  segTo: number;
}

export interface TableModel {
  /** rows[0] is the header row. Every row has `aligns.length` cells. */
  rows: string[][];
  aligns: Align[];
}

export type TableOp =
  | { kind: 'insertRow'; at: number }
  | { kind: 'deleteRow'; at: number }
  | { kind: 'moveRow'; from: number; to: number }
  | { kind: 'insertCol'; at: number }
  | { kind: 'deleteCol'; at: number }
  | { kind: 'moveCol'; from: number; to: number }
  | { kind: 'align'; col: number; align: Align };

const isSpace = (ch: string) => ch === ' ' || ch === '\t';

function escapedAt(s: string, i: number): boolean {
  let count = 0;
  for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) count++;
  return count % 2 === 1;
}

/** Splits a table row on unescaped pipes, ignoring the optional outer pipes. */
export function splitRow(line: string): CellSpan[] {
  let start = 0;
  while (start < line.length && isSpace(line[start])) start++;
  if (line[start] === '|') start++;
  let end = line.length;
  while (end > start && isSpace(line[end - 1])) end--;
  if (end > start && line[end - 1] === '|' && !escapedAt(line, end - 1)) end--;

  const cells: CellSpan[] = [];
  for (let j = start; j <= end; j++) {
    if (j < end && (line[j] !== '|' || escapedAt(line, j))) continue;
    let a = start;
    let b = j;
    while (a < b && isSpace(line[a])) a++;
    while (b > a && isSpace(line[b - 1])) b--;
    cells.push({ text: line.slice(a, b), from: a, to: b, segFrom: start, segTo: j });
    start = j + 1;
  }
  return cells;
}

const fit = (cells: string[], cols: number) =>
  cells.length >= cols ? cells.slice(0, cols) : [...cells, ...Array<string>(cols - cells.length).fill('')];

export function parseTable(text: string): TableModel | null {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]).map((c) => c.text);
  const delimiter = splitRow(lines[1]).map((c) => c.text);
  if (!header.length || !delimiter.every((d) => /^:?-+:?$/.test(d))) return null;
  const aligns = header.map((_, i): Align => {
    const d = delimiter[i] ?? '-';
    const left = d.startsWith(':');
    const right = d.length > 1 && d.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const rows = [header, ...lines.slice(2).map((line) => fit(splitRow(line).map((c) => c.text), header.length))];
  return { rows, aligns };
}

/** Monospace display width: East Asian wide characters and emoji count as two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

export function serializeTable(model: TableModel): string {
  const widths = model.aligns.map(() => 3);
  for (const row of model.rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i], displayWidth(cell)); });
  const pad = (cell: string, i: number) => {
    const gap = widths[i] - displayWidth(cell);
    const align = model.aligns[i];
    if (align === 'right') return ' '.repeat(gap) + cell;
    if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + cell + ' '.repeat(Math.ceil(gap / 2));
    return cell + ' '.repeat(gap);
  };
  const line = (row: string[]) => `| ${row.map(pad).join(' | ')} |`;
  const delimiter = model.aligns.map((align, i) => {
    const w = widths[i];
    if (align === 'center') return ':' + '-'.repeat(w - 2) + ':';
    if (align === 'right') return '-'.repeat(w - 1) + ':';
    if (align === 'left') return ':' + '-'.repeat(w - 1);
    return '-'.repeat(w);
  });
  return [line(model.rows[0]), `| ${delimiter.join(' | ')} |`, ...model.rows.slice(1).map(line)].join('\n');
}

function move<T>(list: T[], from: number, to: number): T[] {
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/** Applies a structural operation. Invalid operations (e.g. deleting the header) return the model unchanged. */
export function applyTableOp(model: TableModel, op: TableOp): TableModel {
  const rows = model.rows.length;
  const cols = model.aligns.length;
  const blank = () => Array<string>(cols).fill('');
  switch (op.kind) {
    case 'insertRow':
      if (op.at < 1 || op.at > rows) return model;
      return { ...model, rows: [...model.rows.slice(0, op.at), blank(), ...model.rows.slice(op.at)] };
    case 'deleteRow':
      if (op.at < 1 || op.at >= rows) return model;
      return { ...model, rows: model.rows.filter((_, i) => i !== op.at) };
    case 'moveRow':
      if (op.from < 1 || op.to < 1 || op.from >= rows || op.to >= rows || op.from === op.to) return model;
      return { ...model, rows: move(model.rows, op.from, op.to) };
    case 'insertCol':
      if (op.at < 0 || op.at > cols) return model;
      return {
        rows: model.rows.map((row) => [...row.slice(0, op.at), '', ...row.slice(op.at)]),
        aligns: [...model.aligns.slice(0, op.at), null, ...model.aligns.slice(op.at)],
      };
    case 'deleteCol':
      if (cols <= 1 || op.at < 0 || op.at >= cols) return model;
      return { rows: model.rows.map((row) => row.filter((_, i) => i !== op.at)), aligns: model.aligns.filter((_, i) => i !== op.at) };
    case 'moveCol':
      if (op.from < 0 || op.to < 0 || op.from >= cols || op.to >= cols || op.from === op.to) return model;
      return { rows: model.rows.map((row) => move(row, op.from, op.to)), aligns: move(model.aligns, op.from, op.to) };
    case 'align':
      return { ...model, aligns: model.aligns.map((a, i) => (i === op.col ? op.align : a)) };
  }
}

/** Escapes a value typed into a cell: newlines become spaces and bare pipes are escaped. */
export function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\\?\|/g, (m) => (m === '|' ? '\\|' : m));
}

/**
 * The smallest change that sets one cell (row 0 = header) of the table `text`.
 * Offsets are relative to the start of `text`. Returns null when nothing changes.
 */
export function cellEdit(text: string, row: number, col: number, value: string): { from: number; to: number; insert: string } | null {
  const lines = text.split('\n');
  const index = row === 0 ? 0 : row + 1;
  if (index >= lines.length) return null;
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  const line = lines[index];
  const cells = splitRow(line);
  const cell = cells[col];
  if (cell) {
    if (cell.text === value) return null;
    if (!cell.text) return { from: offset + cell.segFrom, to: offset + cell.segTo, insert: value ? ` ${value} ` : ' ' };
    return { from: offset + cell.from, to: offset + cell.to, insert: value };
  }
  if (!value) return null;
  // Short row: rewrite it with enough cells.
  const values = fit(cells.map((c) => c.text), col + 1);
  values[col] = value;
  return { from: offset, to: offset + line.length, insert: `| ${values.join(' | ')} |` };
}
