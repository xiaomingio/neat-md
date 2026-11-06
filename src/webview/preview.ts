import type { MarkdownIt } from 'markdown-it';
import { mountMermaid, sanitize } from './rich';
import { htmlToMarkdown } from '../htmlToMarkdown';
import { t } from './i18n';

/**
 * Read-only preview pane for the split modes. Re-rendering reuses unchanged
 * top-level nodes, so diagrams and images are not rebuilt on every keystroke.
 */
export class Preview {
  private blocks: HTMLElement[] = [];
  private readonly observer: IntersectionObserver;

  constructor(readonly scroller: HTMLElement, readonly body: HTMLElement, private readonly onLink: (href: string) => void) {
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        this.observer.unobserve(el);
        mountMermaid(el, el.dataset.source ?? '', t('Rendering diagram…'));
      }
    }, { root: scroller, rootMargin: '300px 0px' });
    // Copying from the preview gives Markdown as plain text (and the HTML for rich editors).
    body.addEventListener('copy', (event) => {
      const selection = getSelection();
      if (!selection || selection.isCollapsed || !event.clipboardData) return;
      const box = document.createElement('div');
      for (let i = 0; i < selection.rangeCount; i++) box.append(selection.getRangeAt(i).cloneContents());
      const markdown = htmlToMarkdown(box.innerHTML);
      if (!markdown) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', markdown);
      event.clipboardData.setData('text/html', box.innerHTML);
    });
    body.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest('a');
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        const target = this.body.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
        target?.scrollIntoView({ block: 'start' });
      } else if (href) {
        this.onLink(href);
      }
    });
  }

  update(md: MarkdownIt, text: string): void {
    const template = document.createElement('template');
    template.innerHTML = sanitize(md.render(text));
    const reusable = new Map<string, Element[]>();
    for (const child of [...this.body.children]) {
      const key = keyOf(child);
      const list = reusable.get(key);
      if (list) list.push(child);
      else reusable.set(key, [child]);
    }

    const next: Node[] = [];
    for (const node of [...template.content.childNodes]) {
      if (!(node instanceof Element)) {
        if (node.textContent?.trim()) next.push(node);
        continue;
      }
      const existing = reusable.get(keyOf(node))?.shift();
      if (existing) {
        const line = node.getAttribute('data-line');
        if (line === null) existing.removeAttribute('data-line');
        else existing.setAttribute('data-line', line);
        next.push(existing);
      } else {
        next.push(node);
        this.enhance(node);
      }
    }
    this.body.replaceChildren(...next);
    this.blocks = [...this.body.querySelectorAll<HTMLElement>(':scope > [data-line]')];
  }

  private enhance(node: Element): void {
    const diagrams = node.matches('.md-mermaid') ? [node] : [...node.querySelectorAll('.md-mermaid')];
    for (const el of diagrams) this.observer.observe(el);
  }

  /** Re-renders diagrams, e.g. after a theme change. */
  refreshDiagrams(): void {
    for (const el of this.body.querySelectorAll<HTMLElement>('.md-mermaid')) {
      el.replaceChildren();
      this.observer.observe(el);
    }
  }

  /** Scroll offset in the preview for a fractional source line. */
  offsetForLine(line: number): number {
    const blocks = this.blocks;
    if (!blocks.length) return 0;
    let i = 0;
    while (i + 1 < blocks.length && Number(blocks[i + 1].dataset.line) <= line) i++;
    const a = blocks[i];
    const b = blocks[i + 1];
    const lineA = Number(a.dataset.line);
    const top = a.offsetTop - this.body.offsetTop;
    if (line <= lineA || !b) return Math.max(0, top - 8);
    const ratio = (line - lineA) / Math.max(1, Number(b.dataset.line) - lineA);
    return top + ratio * (b.offsetTop - a.offsetTop) - 8;
  }

  /** Fractional source line shown at a preview scroll offset. */
  lineForOffset(offset: number): number {
    const blocks = this.blocks;
    if (!blocks.length) return 0;
    const y = offset + this.body.offsetTop + 8;
    let i = 0;
    while (i + 1 < blocks.length && blocks[i + 1].offsetTop <= y) i++;
    const a = blocks[i];
    const b = blocks[i + 1];
    if (!b || y <= a.offsetTop) return Number(a.dataset.line);
    const ratio = (y - a.offsetTop) / Math.max(1, b.offsetTop - a.offsetTop);
    return Number(a.dataset.line) + ratio * (Number(b.dataset.line) - Number(a.dataset.line));
  }
}

/** Identity of a rendered block, ignoring its source line (which shifts on edits elsewhere). */
const keyOf = (el: Element) => el.outerHTML.replace(/ data-line="\d+"/, '');
