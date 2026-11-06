import * as path from 'path';

/* Pure helpers for saving pasted files next to the Markdown document. */

export interface AttachmentFolder {
  absolute: boolean;
  /** The folder as configured, with ${filename} expanded. */
  folder: string;
  /** Relative folder segments (only when not absolute). */
  segments: string[];
}

/** Expands the configured folder. `${filename}` is the document name without extension. */
export function attachmentFolder(setting: string, documentName: string): AttachmentFolder {
  const base = documentName.replace(/\.[^.]*$/, '');
  const folder = (setting.trim() || 'assets').replace(/\$\{filename\}/g, base);
  if (path.isAbsolute(folder) || path.win32.isAbsolute(folder)) return { absolute: true, folder, segments: [] };
  const normalized = path.posix.normalize(folder.replace(/\\/g, '/')).replace(/\/+$/, '');
  return { absolute: false, folder: normalized, segments: normalized.split('/').filter((s) => s && s !== '.') };
}

/** A file name that is safe on every platform; keeps letters in any script. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!clean) clean = 'file';
  if (clean.length > 120) {
    const ext = /\.[^.]{1,10}$/.exec(clean)?.[0] ?? '';
    clean = clean.slice(0, 120 - ext.length) + ext;
  }
  return clean;
}

/** "photo.png" → "photo-2.png". */
export function withSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/** Link text for a saved file, relative to the document folder with forward slashes. */
export function attachmentLink(folder: AttachmentFolder, fileName: string, documentDir?: string): string {
  if (folder.absolute) {
    const target = path.join(folder.folder, fileName);
    return documentDir ? path.relative(documentDir, target).split(path.sep).join('/') : target.split(path.sep).join('/');
  }
  return folder.segments.length ? `${folder.folder}/${fileName}` : fileName;
}

export { linkDestination } from './markdown';
