import { Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import hljs from 'highlight.js/lib/common';

/*
 * Colors fenced code in the editor with the same highlight.js classes the rendered code
 * blocks use, so a code block looks the same while it is being edited.
 */

interface Token { from: number; to: number; cls: string }

const cache = new Map<string, Token[]>();
const ENTITIES: Record<string, number> = { amp: 1, lt: 1, gt: 1, quot: 1, '#x27': 1, '#39': 1 };

function tokens(code: string, lang: string): Token[] {
  const key = lang + '\u0000' + code;
  const cached = cache.get(key);
  if (cached) return cached;
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  const result: Token[] = [];
  const open: { cls: string; from: number }[] = [];
  let pos = 0;
  const re = /<span class="([^"]+)">|<\/span>|&([#\w]+);|[^<&]+|[<&]/g;
  for (let m: RegExpExecArray | null; (m = re.exec(html));) {
    if (m[1] !== undefined) open.push({ cls: m[1], from: pos });
    else if (m[0] === '</span>') {
      const start = open.pop();
      if (start && pos > start.from) result.push({ from: start.from, to: pos, cls: start.cls });
    } else if (m[2] !== undefined) pos += ENTITIES[m[2]] ?? m[0].length;
    else pos += m[0].length;
  }
  // If the mapping drifted (unexpected markup), color nothing rather than the wrong text.
  const tokensOk = pos === code.length ? result : [];
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  cache.set(key, tokensOk);
  return tokensOk;
}

function build(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        if (ref.name !== 'FencedCode') return;
        const info = ref.node.getChild('CodeInfo');
        const text = ref.node.getChild('CodeText');
        if (!info || !text) return false;
        const lang = view.state.sliceDoc(info.from, info.to).trim().split(/\s+/)[0].toLowerCase();
        if (!lang || !hljs.getLanguage(lang)) return false;
        for (const token of tokens(view.state.sliceDoc(text.from, text.to), lang)) {
          ranges.push(Decoration.mark({ class: token.cls }).range(text.from + token.from, text.from + token.to));
        }
        return false;
      },
    });
  }
  return Decoration.set(ranges, true);
}

export const codeHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);
