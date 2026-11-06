import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

/*
 * Converts pasted rich text (web pages, documents, the Neat MD preview) to Markdown.
 * Rendered Neat MD output (KaTeX, Mermaid, code labels, containers) maps back to its source syntax.
 */

type Node = TurndownService.Node;

const classes = (node: Node | Element) => ` ${(node as Element).getAttribute?.('class') ?? ''} `;
const hasClass = (node: Node | Element, name: string) => classes(node).includes(` ${name} `);
const fence = (code: string) => {
  const longest = Math.max(2, ...(code.match(/`{3,}/g) ?? []).map((m) => m.length));
  return '`'.repeat(longest + 1);
};

const mermaidFence = (el: Element) => `\n\n\`\`\`mermaid\n${el.getAttribute('data-source')!.replace(/\n$/, '')}\n\`\`\`\n\n`;

function create(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
    linkStyle: 'inlined',
    // Rendered diagrams have no text, so Turndown would drop them as blank.
    blankReplacement: (_content, node) => {
      const el = node as Element;
      if (hasClass(el, 'md-mermaid') && el.getAttribute('data-source')) return mermaidFence(el);
      return (node as TurndownService.Node & { isBlock?: boolean }).isBlock ? '\n\n' : '';
    },
  });
  td.use(gfm);
  td.remove(['style', 'script', 'noscript', 'meta', 'title', 'link', 'template', 'button'] as TurndownService.Filter);

  td.addRule('katexDisplay', {
    filter: (node) => hasClass(node, 'katex-display'),
    replacement: (_content, node) => {
      const tex = (node as Element).querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      return tex ? `\n\n$$\n${tex}\n$$\n\n` : '';
    },
  });
  td.addRule('katexInline', {
    filter: (node) => hasClass(node, 'katex'),
    replacement: (content, node) => {
      const tex = (node as Element).querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      return tex ? `$${tex}$` : content;
    },
  });
  td.addRule('mermaid', {
    filter: (node) => hasClass(node, 'md-mermaid') && !!(node as Element).getAttribute('data-source'),
    replacement: (_content, node) => mermaidFence(node as Element),
  });
  td.addRule('codeBlock', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const pre = node as Element;
      const label = pre.querySelector('.md-code-lang');
      const code = pre.querySelector('code');
      const cls = classes(code ?? pre) + classes(pre);
      const lang = label?.textContent?.trim() || /(?:language|lang|highlight-source)-([\w+#-]+)/.exec(cls)?.[1] || '';
      let text = (code ?? pre).textContent ?? '';
      if (!code && label) text = text.slice((label.textContent ?? '').length);
      text = text.replace(/\n$/, '');
      const f = fence(text);
      return `\n\n${f}${lang}\n${text}\n${f}\n\n`;
    },
  });
  // One space after the marker ("- item"), as most Markdown is written.
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const parent = node.parentNode as Element | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '\n').replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? '\n' : '');
    },
  });
  td.addRule('containerTitle', { filter: (node) => hasClass(node, 'md-container-title'), replacement: () => '' });
  td.addRule('container', {
    filter: (node) => hasClass(node, 'md-container'),
    replacement: (content, node) => {
      const type = /md-container-(\w+)/.exec(classes(node))?.[1] ?? 'note';
      const title = (node as Element).querySelector('.md-container-title')?.textContent?.trim() ?? '';
      const suffix = title && title.toLowerCase() !== type ? ` ${title}` : '';
      return `\n\n:::${type}${suffix}\n${content.trim()}\n:::\n\n`;
    },
  });
  td.addRule('tableCellInner', { filter: (node) => hasClass(node, 'md-cell-inner'), replacement: (content) => content });
  td.addRule('toc', { filter: (node) => hasClass(node, 'md-toc'), replacement: () => '\n\n[toc]\n\n' });
  td.addRule('footnoteRef', {
    filter: (node) => node.nodeName === 'SUP' && hasClass(node, 'footnote-ref'),
    replacement: (content) => `[^${content.replace(/[^\w-]/g, '')}]`,
  });
  td.addRule('footnotes', {
    filter: (node) => hasClass(node, 'footnotes'),
    replacement: (_content, node) => {
      const items = [...(node as Element).querySelectorAll('li')].map((li, i) => {
        li.querySelectorAll('.footnote-backref').forEach((a) => a.remove());
        const id = /fn(\w+)/.exec(li.getAttribute('id') ?? '')?.[1] ?? String(i + 1);
        return `[^${id}]: ${td.turndown(li.innerHTML).trim()}`;
      });
      return `\n\n${items.join('\n')}\n\n`;
    },
  });
  // Google Docs wraps the whole selection in <b style="font-weight:normal">.
  td.addRule('docsWrapper', {
    filter: (node) => node.nodeName === 'B' && /font-weight:\s*normal/.test((node as Element).getAttribute('style') ?? ''),
    replacement: (content) => content,
  });
  return td;
}

let service: TurndownService | undefined;

export function htmlToMarkdown(html: string): string {
  service ??= create();
  const markdown = service.turndown(html.replace(/<!--(?:Start|End)Fragment-->/g, ''));
  return markdown.replace(/[ \t]+\n/g, (m) => (m.startsWith('  ') ? '  \n' : '\n')).replace(/\n{3,}/g, '\n\n').trim();
}
