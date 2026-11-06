import { Annotation, Compartment, EditorSelection, EditorState, Extension } from '@codemirror/state';
import { drawSelection, EditorView, ViewUpdate, keymap, KeyBinding, placeholder, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, indentWithTab, isolateHistory } from '@codemirror/commands';
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { syntaxTree } from '@codemirror/language';
import { htmlToMarkdown } from '../htmlToMarkdown';
import { codeHighlight } from './codeHighlight';
import { phrases, t } from './i18n';

const sourceHighlight = HighlightStyle.define([
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], class: 'tok-link' },
  { tag: tags.monospace, class: 'tok-code' },
  { tag: tags.quote, class: 'tok-quote' },
  { tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName], class: 'tok-mark' },
  { tag: tags.meta, class: 'tok-mark' },
  { tag: tags.comment, class: 'tok-mark' },
]);

/** Wraps the selection in `mark`, or removes it if already wrapped. */
function toggleMark(mark: string) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const len = mark.length;
    view.dispatch(state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - len, range.from);
      const after = state.sliceDoc(range.to, range.to + len);
      if (before === mark && after === mark) {
        return {
          changes: [{ from: range.from - len, to: range.from }, { from: range.to, to: range.to + len }],
          range: EditorSelection.range(range.from - len, range.to - len),
        };
      }
      return {
        changes: [{ from: range.from, insert: mark }, { from: range.to, insert: mark }],
        range: EditorSelection.range(range.from + len, range.to + len),
      };
    }), { userEvent: 'input.format' });
    return true;
  };
}

/** Wraps the selection as a link and selects the URL placeholder. */
function insertLink(view: EditorView): boolean {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || 'text';
    const insert = `[${text}](url)`;
    const urlStart = range.from + text.length + 3;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlStart, urlStart + 3) };
  }), { userEvent: 'input.format' });
  return true;
}

/** Sets the heading level of every selected line (0 removes the heading). */
function setHeading(level: number) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const changes = [];
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      for (let pos = range.from; pos <= range.to;) {
        const line = state.doc.lineAt(pos);
        if (!seen.has(line.number)) {
          seen.add(line.number);
          const existing = /^#{1,6}\s+/.exec(line.text)?.[0].length ?? 0;
          changes.push({ from: line.from, to: line.from + existing, insert: level ? '#'.repeat(level) + ' ' : '' });
        }
        pos = line.to + 1;
      }
    }
    view.dispatch({ changes, userEvent: 'input.format' });
    return true;
  };
}

const formatKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleMark('**') },
  { key: 'Mod-i', run: toggleMark('*') },
  { key: 'Mod-e', run: toggleMark('`') },
  { key: 'Mod-Shift-x', run: toggleMark('~~') },
  { key: 'Mod-k', run: insertLink },
  { key: 'Mod-r', run: openSearchPanel },
  ...[0, 1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-${level}`, run: setHeading(level) })),
];

/** Shortcuts the editor owns; their keydown must not also reach VS Code keybindings. */
export const ownedShortcut = (event: KeyboardEvent): boolean => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const key = event.key.toLowerCase();
  return ['b', 'i', 'e', 'k', 'f', 'r', '0', '1', '2', '3', '4', '5', '6'].includes(key) || (event.shiftKey && key === 'x');
};

export interface EditorHooks {
  onUpdate(update: ViewUpdate): void;
  onFiles(files: File[], view: EditorView, pos: number): void;
  onOpenLink(href: string): void;
}

export const liveCompartment = new Compartment();
export const historyCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
/** History for the editor's undo steps; each new step is reported to VS Code (see main.ts). */
export const editHistory = () => history({ newGroupDelay: 600 });
/** Keeps a change in its own undo step (table structure, pasted files, checkbox toggles). */
export const ownStep = isolateHistory.of('full');
export const phrasesCompartment = new Compartment();
export const placeholderCompartment = new Compartment();

function filesFrom(data: DataTransfer | null): File[] {
  return data ? [...data.files] : [];
}

/** Rich text that is worth converting: real HTML with visible text, not VS Code's own copy. */
function richHtml(data: DataTransfer): string | null {
  const html = data.getData('text/html');
  if (!html || data.types.includes('vscode-editor-data')) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent?.trim() ? html : null;
}

function inCode(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') return true;
  }
  return false;
}

export function createEditor(parent: HTMLElement, hooks: EditorHooks, live: Extension): EditorView {
  const extensions: Extension[] = [
    drawSelection(),
    rectangularSelection(),
    indentOnInput(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    // The history has no keymap: Cmd+Z goes through VS Code, which replays these steps (see main.ts).
    historyCompartment.of(editHistory()),
    readOnlyCompartment.of([]),
    markdown({ base: markdownLanguage, addKeymap: false }),
    syntaxHighlighting(sourceHighlight),
    codeHighlight,
    search({ top: false }),
    highlightSelectionMatches(),
    keymap.of([...formatKeymap, ...markdownKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
    phrasesCompartment.of(EditorState.phrases.of(phrases())),
    placeholderCompartment.of(placeholder(t('Empty document. Start typing…'))),
    liveCompartment.of(live),
    EditorView.updateListener.of((update) => hooks.onUpdate(update)),
    EditorView.domEventHandlers({
      paste(event, view) {
        if (view.state.readOnly) return true;
        const data = event.clipboardData;
        if (!data) return false;
        const files = filesFrom(data);
        const html = richHtml(data);
        const { state } = view;
        const sel = state.selection.main;
        // Files win unless the clipboard is real rich text that happens to include an image.
        if (files.length && !html) {
          event.preventDefault();
          if (!sel.empty) view.dispatch({ changes: { from: sel.from, to: sel.to }, userEvent: 'delete' });
          hooks.onFiles(files, view, view.state.selection.main.head);
          return true;
        }
        if (html && !inCode(state, sel.head)) {
          const markdown = htmlToMarkdown(html);
          if (!markdown) return false;
          event.preventDefault();
          view.dispatch(state.replaceSelection(markdown), { userEvent: 'input.paste', scrollIntoView: true });
          return true;
        }
        return false;
      },
      drop(event, view) {
        if (view.state.readOnly) { event.preventDefault(); return true; }
        const files = filesFrom(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
        hooks.onFiles(files, view, pos);
        return true;
      },
      mousedown(event, view) {
        const link = (event.target as HTMLElement).closest<HTMLElement>('[data-href]');
        // Links open with Cmd/Ctrl+click while editing, and with a plain click in Preview.
        if (link && (event.metaKey || event.ctrlKey || view.state.readOnly)) {
          event.preventDefault();
          hooks.onOpenLink(link.dataset.href!);
          return true;
        }
        return false;
      },
    }),
  ];
  return new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });
}

/** Marks transactions that came from the host so they are not sent back. */
export const remote = Annotation.define<boolean>();
