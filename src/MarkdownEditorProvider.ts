import * as vscode from 'vscode';
import { MarkdownEditor } from './MarkdownEditor';
import { MarkdownFile } from './MarkdownFile';
import { ExtensionMessage, isViewMode, Locale, ViewMode } from './protocol';

const MODE_KEY = 'neat-md.viewMode';
const LOCALE_KEY = 'neat-md.locale';

/**
 * Neat MD owns the document (like Neat CSV): VS Code tracks dirty state and the undo stack
 * through edit events, asks to save on close, and backs up unsaved changes for hot exit.
 * The editor's own history provides the undo steps.
 */
export class MarkdownEditorProvider implements vscode.CustomEditorProvider<MarkdownFile> {
  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<MarkdownFile>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  private readonly editors = new Map<MarkdownFile, MarkdownEditor>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<MarkdownFile> {
    return MarkdownFile.open(uri, openContext.backupId);
  }

  async resolveCustomEditor(document: MarkdownFile, panel: vscode.WebviewPanel): Promise<void> {
    const editor = new MarkdownEditor(document, panel, this.context.extensionUri, this);
    this.editors.set(document, editor);
    panel.onDidDispose(() => { if (this.editors.get(document) === editor) this.editors.delete(document); });
  }

  /** Records one undo step; undo/redo replay it in the editor's history. */
  recordStep(document: MarkdownFile): void {
    const generation = document.generation;
    const run = (action: 'undo' | 'redo') => {
      if (document.generation === generation) this.editors.get(document)?.history(action);
    };
    this.changes.fire({ document, label: 'Edit Markdown', undo: () => run('undo'), redo: () => run('redo') });
  }

  async saveCustomDocument(document: MarkdownFile): Promise<void> {
    await this.editors.get(document)?.sync();
    await document.saveTo(document.uri);
  }

  async saveCustomDocumentAs(document: MarkdownFile, destination: vscode.Uri): Promise<void> {
    await this.editors.get(document)?.sync();
    await document.saveTo(destination);
  }

  async revertCustomDocument(document: MarkdownFile): Promise<void> {
    const text = await document.reload();
    this.editors.get(document)?.post({ type: 'reset', text });
  }

  async backupCustomDocument(document: MarkdownFile, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    await this.editors.get(document)?.sync();
    await vscode.workspace.fs.writeFile(context.destination, document.encode());
    return {
      id: context.destination.toString(),
      delete: async () => { try { await vscode.workspace.fs.delete(context.destination); } catch { /* already gone */ } },
    };
  }

  public get viewMode(): ViewMode {
    const saved = this.context.globalState.get<string>(MODE_KEY);
    return isViewMode(saved) ? saved : 'live';
  }

  public get locale(): Locale {
    return this.context.globalState.get<string>(LOCALE_KEY) === 'zh-CN' ? 'zh-CN' : 'en';
  }

  /** Remembers the mode and switches every other open Neat MD editor to it. */
  public async setViewMode(mode: ViewMode, from: MarkdownEditor): Promise<void> {
    await this.context.globalState.update(MODE_KEY, mode);
    this.broadcast({ type: 'mode', mode }, from);
  }

  public async setLocale(locale: Locale, from: MarkdownEditor): Promise<void> {
    await this.context.globalState.update(LOCALE_KEY, locale);
    this.broadcast({ type: 'locale', locale }, from);
  }

  public broadcast(message: ExtensionMessage, from?: MarkdownEditor): void {
    for (const editor of this.editors.values()) if (editor !== from) editor.post(message);
  }
}
