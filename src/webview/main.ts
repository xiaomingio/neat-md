import './style.css';
import type { MarkdownIt } from 'markdown-it';
import { EditorView, placeholder, ViewUpdate } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { DEFAULT_CONFIG, EditorConfig, ExtensionMessage, Locale, ViewMode, WebviewMessage } from '../protocol';
import { createMarkdown, linkDestination, resolveAgainst } from '../markdown';
import { diffText } from '../textDiff';
import { createEditor, editHistory, historyCompartment, liveCompartment, ownedShortcut, ownStep, phrasesCompartment, placeholderCompartment, readOnlyCompartment, remote } from './editor';
import { livePreview, refreshLive, syncFocus } from './livePreview';
import { Preview } from './preview';
import { isDarkTheme, mermaidTheme, setMermaidSetting } from './rich';
import { HISTORY_ICONS, ModeMenu, SETTINGS_ICON, SettingsDialog } from './controls';
import { phrases, setLocale, t } from './i18n';

interface VsCodeApi { postMessage(message: WebviewMessage): void }
declare function acquireVsCodeApi(): VsCodeApi;

const vscode: VsCodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => undefined };
const post = (message: WebviewMessage) => vscode.postMessage(message);

const MAX_FILE_BYTES = 50 * 1024 * 1024;

interface PendingFile { pos: number; image: boolean; label: string; leading: string }

class App {
  private config: EditorConfig = DEFAULT_CONFIG;
  private locale: Locale = 'en';
  private baseUri = '';
  private mode: ViewMode = 'live';
  private md: MarkdownIt;
  private readonly view: EditorView;
  private readonly preview: Preview;
  private readonly main: HTMLElement;
  private readonly modeMenu: ModeMenu;
  private readonly settings: SettingsDialog;
  private readonly settingsButton: HTMLButtonElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private autoSaveOff = false;
  private readonly live: ReturnType<typeof livePreview>;
  private editTimer: number | undefined;
  private previewTimer: number | undefined;
  private scrollOwner: 'source' | 'preview' | null = null;
  private scrollRelease: number | undefined;
  private fileId = 0;
  private readonly pendingFiles = new Map<number, PendingFile>();
  private lastTheme = '';

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="md-corner"></div>
      <main class="panes">
        <section class="pane source-pane"></section>
        <section class="pane preview-pane"><article class="md-body preview-body"></article></section>
      </main>`;
    this.main = root.querySelector('.panes')!;
    const previewPane = root.querySelector<HTMLElement>('.preview-pane')!;
    this.md = this.createMd();

    this.modeMenu = new ModeMenu((mode) => this.setMode(mode, true));
    this.settings = new SettingsDialog((values) => this.saveSettings(values), () => post({ type: 'openSettings' }));
    const cornerButton = (cls: string, icon: string, run: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `md-corner-button ${cls}`;
      button.innerHTML = icon;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', run);
      return button;
    };
    this.undoButton = cornerButton('md-undo-button', HISTORY_ICONS.undo, () => this.runCommand('undo'));
    this.redoButton = cornerButton('md-redo-button', HISTORY_ICONS.redo, () => this.runCommand('redo'));
    this.settingsButton = cornerButton('md-settings-button', SETTINGS_ICON,
      () => this.settings.open({ config: this.config, locale: this.locale, autoSaveOff: this.autoSaveOff }));
    root.querySelector('.md-corner')!.append(this.undoButton, this.redoButton, this.modeMenu.button, this.settingsButton);

    this.live = livePreview({
      renderHtml: (text) => this.md.render(text),
      renderInline: (text) => this.md.renderInline(text),
      openLink: (href) => this.openLink(href),
      resolveImage: (src) => resolveAgainst(this.baseUri, src),
      tocMaxDepth: () => this.config.tocMaxDepth,
      theme: () => mermaidTheme(),
      blockEdit: () => this.config.blockEdit,
    });
    // Live extensions are attached in setMode once the document arrives.
    this.view = createEditor(root.querySelector('.source-pane')!, {
      onUpdate: (update) => this.onUpdate(update),
      onFiles: (files, view, pos) => this.insertFiles(files, view, pos),
      onOpenLink: (href) => this.openLink(href),
    }, []);
    this.preview = new Preview(previewPane, previewPane.querySelector('.preview-body')!, (href) => this.openLink(href));

    this.view.scrollDOM.addEventListener('scroll', () => this.syncScroll('source'), { passive: true });
    // Preview: double-click switches this editor to Live at that spot, without remembering the mode.
    this.view.contentDOM.addEventListener('dblclick', (event) => this.editFromPreview(event));
    previewPane.addEventListener('scroll', () => this.syncScroll('preview'), { passive: true });
    // Links inside widgets must never navigate the webview itself.
    document.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('a')) event.preventDefault();
    });
    window.addEventListener('keydown', (event) => this.onGlobalKey(event), true);
    // Native undo (e.g. from a context menu) must not bypass VS Code's undo stack either.
    window.addEventListener('beforeinput', (event) => {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
      event.preventDefault();
      event.stopPropagation();
      this.runCommand(event.inputType === 'historyUndo' ? 'undo' : 'redo');
    }, true);
    // CodeMirror and the table grid handle these; keep VS Code from also running its binding
    // (e.g. Cmd+B toggles the sidebar). On <html> so it runs before the host's forwarding.
    document.documentElement.addEventListener('keydown', (event) => {
      if (event.defaultPrevented && ownedShortcut(event)) event.stopPropagation();
    });
    new MutationObserver(() => this.onThemeChange()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => this.onMessage(event.data));

    this.onThemeChange();
    this.setLanguage('en', false);
    post({ type: 'ready' });
  }

  private createMd(): MarkdownIt {
    return createMarkdown({ resolveImage: (src) => resolveAgainst(this.baseUri, src), tocMaxDepth: this.config.tocMaxDepth });
  }

  private onMessage(message: ExtensionMessage): void {
    switch (message.type) {
      case 'init':
        this.baseUri = message.baseUri;
        this.applyConfig(message.config, true);
        this.setLanguage(message.locale, false);
        this.autoSaveOff = message.autoSaveOff;
        this.resetText(message.text);
        this.setMode(message.mode, false, true);
        if (message.mode !== 'split-preview-source') this.view.focus();
        break;
      case 'reset':
        this.resetText(message.text);
        break;
      case 'history':
        this.applyHistory(message.action);
        break;
      case 'requestText':
        this.flush();
        post({ type: 'text', id: message.id, text: this.view.state.doc.toString() });
        break;
      case 'autoSave':
        this.autoSaveOff = message.off;
        break;
      case 'config':
        this.applyConfig(message.config, false);
        break;
      case 'mode':
        this.setMode(message.mode, false);
        break;
      case 'locale':
        this.setLanguage(message.locale, false);
        break;
      case 'fileSaved':
        this.finishFile(message.id, message.link);
        break;
      case 'fileFailed':
        this.pendingFiles.delete(message.id);
        break;
    }
  }

  private applyConfig(config: EditorConfig, first: boolean): void {
    const tocChanged = config.tocMaxDepth !== this.config.tocMaxDepth;
    this.config = config;
    const style = document.documentElement.style;
    style.setProperty('--md-font-size', `${config.fontSize}px`);
    style.setProperty('--md-line-height', String(config.lineHeight));
    style.setProperty('--md-max-width', config.maxWidth > 0 ? `${config.maxWidth}px` : 'none');
    const themeChanged = setMermaidSetting(config.mermaidTheme);
    if (first || tocChanged) this.md = this.createMd();
    if (!first) {
      if (themeChanged) this.preview.refreshDiagrams();
      this.view.dispatch({ effects: refreshLive.of(null) });
      this.renderPreview();
    }
    this.lastTheme = mermaidTheme();
  }

  private saveSettings(values: { config: EditorConfig; locale: Locale; autoSaveOff: boolean }): void {
    if (values.locale !== this.locale) this.setLanguage(values.locale, true);
    if (values.autoSaveOff !== this.autoSaveOff) {
      this.autoSaveOff = values.autoSaveOff;
      post({ type: 'setAutoSaveOff', off: values.autoSaveOff });
    }
    this.applyConfig(values.config, false);
    post({ type: 'updateSettings', config: values.config });
  }

  private onThemeChange(): void {
    document.documentElement.dataset.theme = isDarkTheme() ? 'dark' : 'light';
    const theme = mermaidTheme();
    if (theme === this.lastTheme) return;
    this.lastTheme = theme;
    this.preview?.refreshDiagrams();
    this.view?.dispatch({ effects: refreshLive.of(null) });
  }

  private setLanguage(locale: Locale, persist: boolean): void {
    this.locale = locale;
    setLocale(locale);
    for (const [button, label] of [[this.settingsButton, t('Settings')], [this.undoButton, t('Undo')], [this.redoButton, t('Redo')]] as const) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    this.modeMenu.render(this.mode);
    if (this.view) {
      this.view.dispatch({
        effects: [
          phrasesCompartment.reconfigure(EditorState.phrases.of(phrases())),
          placeholderCompartment.reconfigure(placeholder(t('Empty document. Start typing…'))),
          refreshLive.of(null),
        ],
      });
    }
    if (persist) post({ type: 'setLocale', locale });
  }

  private setMode(mode: ViewMode, persist: boolean, initial = false): void {
    if (mode === this.mode && !initial) return;
    const topLine = this.topLine();
    const rendered = (m: ViewMode) => m === 'live' || m === 'preview';
    const liveChanged = initial || rendered(this.mode) !== rendered(mode);
    const readOnlyChanged = initial || (this.mode === 'preview') !== (mode === 'preview');
    this.mode = mode;
    this.main.dataset.mode = mode;
    this.modeMenu.render(mode);
    this.view.contentDOM.title = mode === 'preview' ? t('Double-click to edit in Live') : '';
    const effects = [];
    if (liveChanged) effects.push(liveCompartment.reconfigure(rendered(mode) ? this.live : []));
    if (readOnlyChanged) {
      // Preview: the same rendering as Live, but nothing can be edited.
      effects.push(readOnlyCompartment.reconfigure(mode === 'preview' ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []));
      effects.push(refreshLive.of(null));
    }
    if (effects.length) this.view.dispatch({ effects });
    if (liveChanged && rendered(mode)) syncFocus(this.view);
    if (mode.startsWith('split')) this.renderPreview();
    requestAnimationFrame(() => {
      this.scrollToLine(topLine);
      if (mode.startsWith('split')) this.syncScroll('source');
    });
    if (persist) {
      post({ type: 'setMode', mode });
      if (mode !== 'preview') this.view.focus();
    }
    this.updateHistoryButtons();
  }

  private editFromPreview(event: MouseEvent): void {
    if (this.mode !== 'preview' || (event.target as HTMLElement).closest('a, input')) return;
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    getSelection()?.removeAllRanges();
    this.setMode('live', false);
    if (pos === null) return;
    this.view.focus();
    this.view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
    requestAnimationFrame(() => this.view.dispatch({ effects: EditorView.scrollIntoView(this.view.state.selection.main.head, { y: 'nearest', yMargin: 48 }) }));
  }

  /** Undo, redo and save go through the host after flushing, so they act on the latest text. */
  private onGlobalKey(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    if ((event.target as HTMLElement).closest?.('dialog')) return;
    const key = event.key.toLowerCase();
    let command: 'undo' | 'redo' | 'save' | undefined;
    if (key === 'z') command = event.shiftKey ? 'redo' : 'undo';
    else if (key === 'y' && !event.shiftKey) command = 'redo';
    else if (key === 's' && !event.shiftKey) command = 'save';
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    this.runCommand(command);
  }

  /** Undo, redo and save run through VS Code, which owns the undo stack and dirty state. */
  private runCommand(command: 'undo' | 'redo' | 'save'): void {
    if (command !== 'save' && this.mode === 'preview') return;
    this.flush();
    post({ type: 'command', command });
  }

  /** VS Code replays one of the steps this editor reported. */
  private applyHistory(action: 'undo' | 'redo'): void {
    const before = this.view.state.doc;
    (action === 'undo' ? undo : redo)(this.view);
    if (this.view.state.doc !== before) post({ type: 'edit', text: this.view.state.doc.toString(), step: false });
    this.updateHistoryButtons();
  }

  /** Replaces the text and starts a fresh history (open, revert, external change). */
  private resetText(text: string): void {
    window.clearTimeout(this.editTimer);
    this.editTimer = undefined;
    const doc = this.view.state.doc;
    if (doc.toString() !== text) {
      const change = diffText(doc.toString(), text) ?? { from: 0, to: doc.length, insert: text };
      this.view.dispatch({ changes: change, annotations: remote.of(true) });
    }
    this.view.dispatch({ effects: historyCompartment.reconfigure([]) });
    this.view.dispatch({ effects: historyCompartment.reconfigure(editHistory()) });
    this.schedulePreview();
    this.updateHistoryButtons();
  }

  private updateHistoryButtons(): void {
    this.undoButton.disabled = undoDepth(this.view.state) === 0;
    this.redoButton.disabled = redoDepth(this.view.state) === 0;
  }

  private onUpdate(update: ViewUpdate): void {
    if (!update.docChanged) return;
    for (const file of this.pendingFiles.values()) file.pos = update.changes.mapPos(file.pos, 1);
    if (update.transactions.every((tr) => tr.annotation(remote))) return;
    this.schedulePreview();
    this.updateHistoryButtons();
    if (update.transactions.some((tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'))) return;
    // A new history group is a new undo step for VS Code; edits within a group only update the text.
    if (undoDepth(update.state) > undoDepth(update.startState)) {
      window.clearTimeout(this.editTimer);
      this.editTimer = undefined;
      post({ type: 'edit', text: update.state.doc.toString(), step: true });
      return;
    }
    window.clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => this.flush(), 150);
  }

  private flush(): void {
    if (this.editTimer === undefined) return;
    window.clearTimeout(this.editTimer);
    this.editTimer = undefined;
    post({ type: 'edit', text: this.view.state.doc.toString(), step: false });
  }

  private schedulePreview(): void {
    if (!this.mode.startsWith('split')) return;
    window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => this.renderPreview(), 150);
  }

  private renderPreview(): void {
    window.clearTimeout(this.previewTimer);
    if (!this.mode.startsWith('split')) return;
    this.preview.update(this.md, this.view.state.doc.toString());
  }

  private topLine(): number {
    const block = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop);
    return this.view.state.doc.lineAt(block.from).number - 1;
  }

  private scrollToLine(line: number): void {
    const doc = this.view.state.doc;
    const pos = doc.line(Math.min(doc.lines, Math.max(1, Math.floor(line) + 1))).from;
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
  }

  private syncScroll(from: 'source' | 'preview'): void {
    if (!this.mode.startsWith('split') || (this.scrollOwner && this.scrollOwner !== from)) return;
    this.scrollOwner = from;
    window.clearTimeout(this.scrollRelease);
    this.scrollRelease = window.setTimeout(() => { this.scrollOwner = null; }, 120);

    const scroller = this.view.scrollDOM;
    const previewPane = this.preview.scroller;
    if (from === 'source') {
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        previewPane.scrollTop = previewPane.scrollHeight;
        return;
      }
      const block = this.view.lineBlockAtHeight(scroller.scrollTop);
      const line = this.view.state.doc.lineAt(block.from).number - 1;
      const fraction = block.height ? (scroller.scrollTop - block.top) / block.height : 0;
      previewPane.scrollTop = this.preview.offsetForLine(line + Math.max(0, Math.min(1, fraction)));
    } else {
      if (previewPane.scrollTop + previewPane.clientHeight >= previewPane.scrollHeight - 2) {
        scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      const line = this.preview.lineForOffset(previewPane.scrollTop);
      const doc = this.view.state.doc;
      const whole = Math.min(doc.lines, Math.floor(line) + 1);
      const block = this.view.lineBlockAt(doc.line(whole).from);
      scroller.scrollTop = block.top + (line - Math.floor(line)) * block.height;
    }
  }

  public openLink(href: string): void {
    if (!href.startsWith('#')) post({ type: 'openLink', href });
  }

  /**
   * Pasted or dropped files are saved by the host into the attachment folder (default
   * "assets" next to the document) and linked; images can be embedded instead.
   */
  private insertFiles(files: File[], view: EditorView, pos: number): void {
    const line = view.state.doc.lineAt(pos);
    let first = true;
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        post({ type: 'warn', message: `${file.name}: ${t('Files larger than 50 MB are not pasted.')}` });
        continue;
      }
      const image = file.type.startsWith('image/');
      const id = ++this.fileId;
      const name = fileName(file);
      const label = image ? name.replace(/\.[^.]+$/, '') : name;
      // Several files go on separate lines; the first one joins the current line.
      const leading = first ? (pos > line.from && !/\s$/.test(view.state.sliceDoc(pos - 1, pos)) ? ' ' : '') : '\n';
      first = false;
      this.pendingFiles.set(id, { pos, image, label, leading });
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        if (image && this.config.embedImages) this.finishFile(id, dataUrl);
        else post({ type: 'saveFile', id, name, dataUrl });
      };
      reader.onerror = () => this.pendingFiles.delete(id);
      reader.readAsDataURL(file);
    }
  }

  private finishFile(id: number, link: string): void {
    const file = this.pendingFiles.get(id);
    if (!file) return;
    this.pendingFiles.delete(id);
    const label = file.label.replace(/[[\]\\]/g, '\\$&');
    const target = link.startsWith('data:') ? link : linkDestination(link.replace(/^<|>$/g, ''));
    const insert = `${file.leading}${file.image ? '!' : ''}[${label}](${target})`;
    const end = file.pos + insert.length;
    this.view.dispatch({ changes: { from: file.pos, insert }, selection: { anchor: end }, userEvent: 'input.paste', scrollIntoView: true, annotations: ownStep });
    // Later files from the same paste go after this one.
    for (const other of this.pendingFiles.values()) if (other.pos === file.pos) other.pos = end;
  }
}

/** Clipboard images are usually called "image.png"; give them a dated name instead. */
function fileName(file: File): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
  const ext = (/^image\/(png|jpe?g|gif|webp|svg|bmp|avif)/.exec(file.type)?.[1] ?? 'png').replace('jpeg', 'jpg');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `image-${stamp}.${ext}`;
}

new App(document.getElementById('root')!);
