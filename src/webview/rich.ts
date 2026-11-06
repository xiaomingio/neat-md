import DOMPurify from 'dompurify';

/* Browser-only helpers: HTML sanitizing and on-demand Mermaid rendering with caching. */

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-line', 'data-source', 'target'],
    ADD_TAGS: ['semantics', 'annotation'],
    FORBID_TAGS: ['style', 'form'],
  });
}

export type MermaidSetting = 'auto' | 'default' | 'dark' | 'neutral' | 'forest';

interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let setting: MermaidSetting = 'auto';
let loader: Promise<MermaidApi> | undefined;
let initializedTheme = '';
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;
const cache = new Map<string, Promise<string>>();
/** Last rendered height per source, so Live widgets reserve space while re-rendering. */
export const mermaidHeights = new Map<string, number>();

export const isDarkTheme = () =>
  document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');

/** "auto" uses Neat MD's own light/dark palette; other values are Mermaid's built-in themes. */
export function mermaidTheme(): string {
  return setting === 'auto' ? (isDarkTheme() ? 'neat-dark' : 'neat-light') : setting;
}

const PALETTES: Record<string, Record<string, string>> = {
  'neat-light': {
    primaryColor: '#e7f0fd', primaryBorderColor: '#b9d3f5', primaryTextColor: '#1d5fb4',
    secondaryColor: '#eef6ea', tertiaryColor: '#f6f8fa', lineColor: '#7d8590', textColor: '#1f2328',
    edgeLabelBackground: '#ffffff', clusterBkg: '#f6f8fa', clusterBorder: '#d0d7de', noteBkgColor: '#fff8c5', noteBorderColor: '#d4a72c',
  },
  'neat-dark': {
    primaryColor: '#16304f', primaryBorderColor: '#2f5c91', primaryTextColor: '#cfe3ff', darkMode: 'true',
    secondaryColor: '#1d3324', tertiaryColor: '#1c2128', lineColor: '#8b949e', textColor: '#e6edf3', background: '#1e1e1e',
    edgeLabelBackground: '#1e1e1e', clusterBkg: '#1c2128', clusterBorder: '#3d444d', noteBkgColor: '#3b3424', noteBorderColor: '#9e7c24',
  },
};

function mermaidConfig(theme: string): Record<string, unknown> {
  const palette = PALETTES[theme];
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    fontFamily: 'inherit',
    // SVG text labels: HTML labels inside <foreignObject> do not survive sanitizing.
    htmlLabels: false,
    flowchart: { htmlLabels: false, curve: palette ? 'step' : 'basis', nodeSpacing: 40, rankSpacing: 48, padding: 12 },
    theme: palette ? 'base' : theme,
    ...(palette ? { themeVariables: { ...palette, darkMode: palette.darkMode === 'true', fontSize: '14px' } } : {}),
  };
}

/** Edge labels become opaque pills that sit on the line instead of overlapping it; nodes get rounded corners. */
function polishSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') return svg;
  for (const rect of root.querySelectorAll('.edgeLabel rect.background')) {
    const width = Number(rect.getAttribute('width'));
    const height = Number(rect.getAttribute('height'));
    if (!width || !height) continue;
    const padX = 8;
    rect.setAttribute('x', String(Number(rect.getAttribute('x')) - padX));
    rect.setAttribute('width', String(width + padX * 2));
    rect.setAttribute('rx', String(height / 2));
    rect.setAttribute('ry', String(height / 2));
    rect.setAttribute('class', 'background md-edge-pill');
  }
  for (const rect of root.querySelectorAll('.node rect.label-container, .node rect.basic')) {
    if (!rect.getAttribute('rx')) { rect.setAttribute('rx', '8'); rect.setAttribute('ry', '8'); }
  }
  return new XMLSerializer().serializeToString(root);
}

export function setMermaidSetting(value: MermaidSetting): boolean {
  const before = mermaidTheme();
  setting = value;
  return before !== mermaidTheme();
}

function loadMermaid(): Promise<MermaidApi> {
  loader ??= new Promise<MermaidApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = document.body.dataset.mermaid ?? '';
    script.onload = () => {
      const api = (window as unknown as { mermaid?: MermaidApi }).mermaid;
      if (api) resolve(api);
      else reject(new Error('Mermaid did not load'));
    };
    script.onerror = () => reject(new Error('Mermaid did not load'));
    document.head.append(script);
  });
  return loader;
}

/** Renders a diagram to sanitized SVG. Renders run one at a time; results are cached per theme and source. */
export function renderMermaid(source: string): Promise<string> {
  const theme = mermaidTheme();
  const key = theme + '\u0000' + source;
  let result = cache.get(key);
  if (!result) {
    result = queue.then(async () => {
      const mermaid = await loadMermaid();
      if (initializedTheme !== theme) {
        mermaid.initialize(mermaidConfig(theme));
        initializedTheme = theme;
      }
      const id = `neat-md-mermaid-${++counter}`;
      try {
        const { svg } = await mermaid.render(id, source);
        return polishSvg(DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ['foreignObject'] }));
      } finally {
        document.getElementById(id)?.remove();
        document.getElementById('d' + id)?.remove();
      }
    });
    queue = result.catch(() => undefined);
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    // Failed renders are not cached, so fixing the source retries.
    result.catch(() => cache.delete(key));
  }
  return result;
}

/** Fills a container with the rendered diagram, or an inline error message. */
export function mountMermaid(element: HTMLElement, source: string, loading: string, onRendered?: () => void): void {
  const height = mermaidHeights.get(source);
  if (height) element.style.minHeight = `${height}px`;
  if (!element.firstChild) element.innerHTML = `<div class="md-placeholder">${loading}</div>`;
  renderMermaid(source).then(
    (svg) => {
      if (!element.isConnected && element.dataset.mounted) return;
      element.innerHTML = svg;
      element.style.minHeight = '';
      onRendered?.();
      requestAnimationFrame(() => {
        if (element.offsetHeight) mermaidHeights.set(source, element.offsetHeight);
      });
    },
    (error: unknown) => {
      element.style.minHeight = '';
      const box = document.createElement('div');
      box.className = 'md-error';
      box.textContent = error instanceof Error ? error.message : String(error);
      element.replaceChildren(box);
      onRendered?.();
    }
  );
  element.dataset.mounted = '1';
}
