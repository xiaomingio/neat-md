import * as vscode from 'vscode';

const BOM = '﻿';

/**
 * A Markdown file owned by Neat MD. Text is kept with LF line endings; the original
 * line ending style and byte order mark are restored on save.
 */
export class MarkdownFile implements vscode.CustomDocument {
  /** Current text (LF), as last reported by the editor. */
  text: string;
  /** Text (LF) as it was last read from or written to disk. */
  savedText: string;
  /** Changes whenever the text is replaced wholesale, invalidating older undo entries. */
  generation = 0;
  private eol: '\n' | '\r\n';
  private bom: boolean;
  private writing = 0;
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  private constructor(readonly uri: vscode.Uri, raw: string, saved: string) {
    const decoded = decode(raw);
    this.text = decoded.text;
    this.eol = decoded.eol;
    this.bom = decoded.bom;
    this.savedText = decode(saved).text;
  }

  static async open(uri: vscode.Uri, backupId?: string): Promise<MarkdownFile> {
    const disk = uri.scheme === 'untitled' ? '' : await readText(uri).catch(() => '');
    const raw = backupId ? await readText(vscode.Uri.parse(backupId)) : disk;
    return new MarkdownFile(uri, raw, disk);
  }

  /** True while this document is writing its own file, so watchers can ignore the change. */
  get isWriting(): boolean { return this.writing > 0; }

  encode(text = this.text): Uint8Array {
    const body = this.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
    return new TextEncoder().encode((this.bom ? BOM : '') + body);
  }

  async saveTo(target: vscode.Uri): Promise<void> {
    this.writing++;
    try {
      await vscode.workspace.fs.writeFile(target, this.encode());
    } finally {
      // File watchers report shortly after the write; keep ignoring briefly.
      setTimeout(() => this.writing--, 500);
    }
    if (target.toString() === this.uri.toString()) this.savedText = this.text;
  }

  /** Reloads from disk. Returns the new text. */
  async reload(): Promise<string> {
    const decoded = decode(await readText(this.uri));
    this.text = decoded.text;
    this.savedText = decoded.text;
    this.eol = decoded.eol;
    this.bom = decoded.bom;
    this.generation++;
    return this.text;
  }

  async readDisk(): Promise<string> {
    return decode(await readText(this.uri)).text;
  }

  dispose(): void {
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
}

function decode(raw: string): { text: string; eol: '\n' | '\r\n'; bom: boolean } {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/(?<!\r)\n/g) ?? []).length;
  return { text: body.replace(/\r\n?/g, '\n'), eol: crlf > lf ? '\r\n' : '\n', bom };
}
