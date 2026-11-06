import * as vscode from 'vscode';
import * as path from 'path';
import { EditorConfig, ExtensionMessage, isLocale, isViewMode, sanitizeConfig, WebviewMessage } from './protocol';
import type { MarkdownEditorProvider } from './MarkdownEditorProvider';
import type { MarkdownFile } from './MarkdownFile';
import { attachmentFolder, attachmentLink, linkDestination, safeFileName, withSuffix } from './attachments';
import { getWebviewContent } from './utils';

/** Configuration keys behind each editor setting. */
const SETTING_KEYS: Record<keyof EditorConfig, string> = {
  fontSize: 'preview.fontSize',
  lineHeight: 'preview.lineHeight',
  maxWidth: 'preview.maxWidth',
  attachmentFolder: 'attachments.folder',
  embedImages: 'attachments.embedImages',
  mermaidTheme: 'mermaid.theme',
  tocMaxDepth: 'toc.maxDepth',
  blockEdit: 'live.blockEdit',
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** True when VS Code auto save is off for Markdown, so closing unsaved files asks first (the default). */
export function markdownAutoSaveOff(): boolean {
  return vscode.workspace.getConfiguration('files', { languageId: 'markdown' }).get<string>('autoSave') === 'off';
}

/**
 * On: drop the user's Markdown override so Neat MD's default ("off") applies, or write "off" if a
 * workspace still overrides it. Off: Markdown follows the user's general auto save setting.
 */
async function setMarkdownAutoSaveOff(off: boolean): Promise<void> {
  const markdown = vscode.workspace.getConfiguration('files', { languageId: 'markdown' });
  if (off) {
    await markdown.update('autoSave', undefined, vscode.ConfigurationTarget.Global, true);
    if (!markdownAutoSaveOff()) await markdown.update('autoSave', 'off', vscode.ConfigurationTarget.Global, true);
  } else {
    const general = vscode.workspace.getConfiguration('files').inspect<string>('autoSave');
    const value = general?.globalValue ?? general?.defaultValue ?? 'off';
    await markdown.update('autoSave', value === 'off' ? 'afterDelay' : value, vscode.ConfigurationTarget.Global, true);
  }
}

/** Connects one webview panel to one Markdown file. */
export class MarkdownEditor {
  private readonly disposables: vscode.Disposable[] = [];
  private requestId = 0;
  private readonly pending = new Map<number, (text: string) => void>();

  constructor(
    private readonly file: MarkdownFile,
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly provider: MarkdownEditorProvider
  ) {
    const roots = [vscode.Uri.joinPath(extensionUri, 'dist')];
    if (file.uri.scheme !== 'untitled') roots.push(this.documentDir());
    for (const folder of vscode.workspace.workspaceFolders ?? []) roots.push(folder.uri);

    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = getWebviewContent(panel.webview, extensionUri);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('neat-md')) this.post({ type: 'config', config: this.config() });
        if (e.affectsConfiguration('files.autoSave')) this.post({ type: 'autoSave', off: markdownAutoSaveOff() });
      }),
      panel.onDidDispose(() => this.dispose())
    );
    if (file.uri.scheme === 'file') this.watch();
  }

  public post(message: ExtensionMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private documentDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.file.uri, '..');
  }

  /** Gets the newest text from the editor (it reports typing with a short delay). */
  public sync(): Promise<void> {
    const id = ++this.requestId;
    return new Promise<void>((resolve) => {
      const done = (text?: string) => {
        if (!this.pending.delete(id)) return;
        if (text !== undefined) this.file.text = text;
        resolve();
      };
      this.pending.set(id, done);
      this.post({ type: 'requestText', id });
      // A hidden or closing webview may not answer; keep the last reported text.
      setTimeout(() => done(), 1500);
    });
  }

  /** Applies a VS Code undo/redo to the editor's history. */
  public history(action: 'undo' | 'redo'): void {
    this.post({ type: 'history', action });
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({
          type: 'init',
          text: this.file.text,
          mode: this.provider.viewMode,
          locale: this.provider.locale,
          config: this.config(),
          baseUri: this.file.uri.scheme === 'untitled' ? '' : this.panel.webview.asWebviewUri(this.documentDir()).toString() + '/',
          autoSaveOff: markdownAutoSaveOff(),
        });
        break;
      case 'edit':
        this.file.text = message.text;
        if (message.step) this.provider.recordStep(this.file);
        break;
      case 'text':
        this.pending.get(message.id)?.(message.text);
        break;
      case 'command':
        // VS Code routes these to this editor: undo/redo replay recorded steps, save calls the provider.
        await vscode.commands.executeCommand(message.command === 'save' ? 'workbench.action.files.save' : message.command);
        break;
      case 'setMode':
        if (isViewMode(message.mode)) await this.provider.setViewMode(message.mode, this);
        break;
      case 'setLocale':
        if (isLocale(message.locale)) await this.provider.setLocale(message.locale, this);
        break;
      case 'updateSettings':
        await this.updateSettings(sanitizeConfig(message.config));
        break;
      case 'setAutoSaveOff':
        await setMarkdownAutoSaveOff(message.off);
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xiaomingio.neat-md');
        break;
      case 'openLink':
        await this.openLink(message.href);
        break;
      case 'saveFile':
        await this.saveFile(message.id, message.name, message.dataUrl);
        break;
      case 'warn':
        void vscode.window.showWarningMessage(String(message.message).slice(0, 500));
        break;
    }
  }

  /** Reloads the editor when the file changes on disk and there are no unsaved edits. */
  private watch(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.documentDir(), path.posix.basename(this.file.uri.path))
    );
    const onChange = async () => {
      if (this.file.isWriting) return;
      await this.sync();
      let disk: string;
      try { disk = await this.file.readDisk(); } catch { return; }
      if (disk === this.file.savedText) return;
      if (this.file.text === this.file.savedText) {
        await this.provider.revertCustomDocument(this.file);
      } else {
        void vscode.window.showWarningMessage(
          `${path.posix.basename(this.file.uri.path)} changed on disk. Saving will overwrite those changes; use File > Revert to load them.`
        );
      }
    };
    this.disposables.push(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange));
  }

  private config(): EditorConfig {
    const c = vscode.workspace.getConfiguration('neat-md');
    const raw = Object.fromEntries(Object.entries(SETTING_KEYS).map(([field, key]) => [field, c.get(key)]));
    return sanitizeConfig(raw);
  }

  /** Writes changed settings where they are currently defined (workspace if overridden there, else user). */
  private async updateSettings(next: EditorConfig): Promise<void> {
    const c = vscode.workspace.getConfiguration('neat-md');
    const current = this.config();
    for (const field of Object.keys(SETTING_KEYS) as (keyof EditorConfig)[]) {
      if (next[field] === current[field]) continue;
      const key = SETTING_KEYS[field];
      const info = c.inspect(key);
      const target = info?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : info?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await c.update(key, next[field], target);
    }
  }

  private async openLink(href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // Ignore other schemes such as command: or file:.
    const [filePart] = href.replace(/^<|>$/g, '').split('#');
    if (!filePart || this.file.uri.scheme === 'untitled') return;
    let decoded = filePart;
    try { decoded = decodeURIComponent(filePart); } catch { /* keep raw */ }
    const target = vscode.Uri.joinPath(this.documentDir(), ...decoded.split('/'));
    try {
      await vscode.workspace.fs.stat(target);
      await vscode.commands.executeCommand('vscode.open', target);
    } catch {
      void vscode.window.showWarningMessage(`File not found: ${decoded}`);
    }
  }

  /** Saves a pasted or dropped file into the attachment folder and replies with the link to insert. */
  private async saveFile(id: number, name: string, dataUrl: string): Promise<void> {
    const fail = (text?: string) => {
      if (text) void vscode.window.showErrorMessage(text);
      this.post({ type: 'fileFailed', id });
    };
    if (this.file.uri.scheme === 'untitled') return fail('Save the Markdown file first, so pasted files can be stored next to it.');
    const match = /^data:[^,]*?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!match) return fail();
    const bytes = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]));
    if (bytes.length > MAX_FILE_BYTES) return fail('Pasted file is larger than 50 MB.');

    const folder = attachmentFolder(this.config().attachmentFolder, path.posix.basename(this.file.uri.path));
    const target = folder.absolute ? vscode.Uri.file(folder.folder) : vscode.Uri.joinPath(this.documentDir(), ...folder.segments);
    try {
      await vscode.workspace.fs.createDirectory(target);
      const base = safeFileName(name);
      let fileName = base;
      for (let n = 2; await exists(vscode.Uri.joinPath(target, fileName)); n++) fileName = withSuffix(base, n);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, fileName), bytes);
      const docDir = this.file.uri.scheme === 'file' ? path.dirname(this.file.uri.fsPath) : undefined;
      this.post({ type: 'fileSaved', id, link: linkDestination(attachmentLink(folder, fileName, docDir)) });
    } catch (error) {
      fail(`Could not save ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private dispose(): void {
    for (const resolve of this.pending.values()) resolve(this.file.text);
    this.pending.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
