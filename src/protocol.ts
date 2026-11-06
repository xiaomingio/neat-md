export type ViewMode = 'live' | 'preview' | 'source' | 'split-source-preview' | 'split-preview-source';
export type Locale = 'en' | 'zh-CN';
export type MermaidSetting = 'auto' | 'default' | 'dark' | 'neutral' | 'forest';
/** How formulas, diagrams and the table of contents open for editing in Live mode. */
export type BlockEdit = 'doubleClick' | 'click';

export const VIEW_MODES: readonly ViewMode[] = ['live', 'preview', 'source', 'split-source-preview', 'split-preview-source'];
export const MERMAID_SETTINGS: readonly MermaidSetting[] = ['auto', 'default', 'dark', 'neutral', 'forest'];

export interface EditorConfig {
  fontSize: number;
  lineHeight: number;
  /** 0 means no limit. */
  maxWidth: number;
  /** Folder for pasted files, relative to the document; `${filename}` is the document name. */
  attachmentFolder: string;
  /** Embed pasted images as data URLs instead of saving files. */
  embedImages: boolean;
  mermaidTheme: MermaidSetting;
  tocMaxDepth: number;
  blockEdit: BlockEdit;
}

export const DEFAULT_CONFIG: EditorConfig = {
  fontSize: 16,
  lineHeight: 1.6,
  maxWidth: 900,
  attachmentFolder: 'assets',
  embedImages: false,
  mermaidTheme: 'auto',
  tocMaxDepth: 3,
  blockEdit: 'doubleClick',
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Validates settings from configuration or the webview. */
export function sanitizeConfig(input: Partial<Record<keyof EditorConfig, unknown>>): EditorConfig {
  const d = DEFAULT_CONFIG;
  const folder = typeof input.attachmentFolder === 'string' ? input.attachmentFolder.trim() : '';
  return {
    fontSize: clamp(input.fontSize, 10, 32, d.fontSize),
    lineHeight: clamp(input.lineHeight, 1, 3, d.lineHeight),
    maxWidth: Math.round(clamp(input.maxWidth, 0, 4000, d.maxWidth)),
    attachmentFolder: folder || d.attachmentFolder,
    embedImages: input.embedImages === true,
    mermaidTheme: (MERMAID_SETTINGS as readonly unknown[]).includes(input.mermaidTheme) ? (input.mermaidTheme as MermaidSetting) : d.mermaidTheme,
    tocMaxDepth: Math.round(clamp(input.tocMaxDepth, 1, 6, d.tocMaxDepth)),
    blockEdit: input.blockEdit === 'click' ? 'click' : 'doubleClick',
  };
}

/** Messages from the extension host to the webview. */
export type ExtensionMessage =
  | { type: 'init'; text: string; mode: ViewMode; locale: Locale; config: EditorConfig; baseUri: string; autoSaveOff: boolean }
  /** Replace the whole text and clear undo history (revert, external change). */
  | { type: 'reset'; text: string }
  /** VS Code ran Undo/Redo for this document; apply it to the editor's history. */
  | { type: 'history'; action: 'undo' | 'redo' }
  /** Reply with { type: 'text', id } carrying the current text (before save and backup). */
  | { type: 'requestText'; id: number }
  | { type: 'autoSave'; off: boolean }
  | { type: 'config'; config: EditorConfig }
  /** Mode or language changed in another Neat MD editor. */
  | { type: 'mode'; mode: ViewMode }
  | { type: 'locale'; locale: Locale }
  | { type: 'fileSaved'; id: number; link: string }
  | { type: 'fileFailed'; id: number };

/** Messages from the webview to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  /** `step` marks a new undo step, which becomes one VS Code undo entry. */
  | { type: 'edit'; text: string; step: boolean }
  | { type: 'text'; id: number; text: string }
  /** Undo, redo and save run through VS Code so its undo stack and dirty state stay in charge. */
  | { type: 'command'; command: 'undo' | 'redo' | 'save' }
  /** Turn VS Code auto save off (or back to the user's default) for Markdown files only. */
  | { type: 'setAutoSaveOff'; off: boolean }
  | { type: 'setMode'; mode: ViewMode }
  | { type: 'setLocale'; locale: Locale }
  | { type: 'updateSettings'; config: EditorConfig }
  | { type: 'openSettings' }
  | { type: 'openLink'; href: string }
  | { type: 'saveFile'; id: number; name: string; dataUrl: string }
  | { type: 'warn'; message: string };

export const isViewMode = (value: unknown): value is ViewMode =>
  typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);

export const isLocale = (value: unknown): value is Locale => value === 'en' || value === 'zh-CN';
