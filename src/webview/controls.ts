import { EditorConfig, Locale, ViewMode } from '../protocol';
import { t } from './i18n';

/* Shared popup menu, the mode switcher and the settings dialog. */

export type MenuItem =
  | 'separator'
  | { label: string; shortcut?: string; checked?: boolean; disabled?: boolean; danger?: boolean; icon?: string; run: () => void };

let closeCurrent: (() => void) | null = null;

/** Opens a popup menu at a point. `onCancel` runs when it closes without choosing an item. */
export function openMenu(items: MenuItem[], at: { x: number; y: number; alignRight?: boolean }, onCancel?: () => void): void {
  closeCurrent?.();
  const previous = document.activeElement as HTMLElement | null;
  const menu = document.createElement('div');
  menu.className = 'md-menu';
  menu.setAttribute('role', 'menu');
  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === 'separator') {
      menu.append(Object.assign(document.createElement('div'), { className: 'md-menu-sep' }));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-menu-item' + (item.danger ? ' md-menu-danger' : '');
    button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (item.checked !== undefined) button.setAttribute('aria-checked', String(item.checked));
    button.disabled = !!item.disabled;
    button.innerHTML = `<span class="md-menu-check">${item.checked ? '✓' : ''}</span>${item.icon ?? ''}<span class="md-menu-label"></span><span class="md-menu-key"></span>`;
    button.querySelector('.md-menu-label')!.textContent = item.label;
    button.querySelector('.md-menu-key')!.textContent = item.shortcut ?? '';
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => { close(false); item.run(); });
    menu.append(button);
    buttons.push(button);
  }
  document.body.append(menu);

  const rect = menu.getBoundingClientRect();
  let left = at.alignRight ? at.x - rect.width : at.x;
  let top = at.y;
  left = Math.max(4, Math.min(left, innerWidth - rect.width - 4));
  if (top + rect.height > innerHeight - 4) top = Math.max(4, at.y - rect.height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const enabled = () => buttons.filter((b) => !b.disabled);
  const focusAt = (index: number) => { const list = enabled(); list[(index + list.length) % list.length]?.focus(); };
  const checked = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true' && !b.disabled);
  (checked >= 0 ? buttons[checked] : enabled()[0])?.focus();

  const onKey = (event: KeyboardEvent) => {
    const list = enabled();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') focusAt(index + 1);
    else if (event.key === 'ArrowUp') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(list.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') close(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onDown = (event: MouseEvent) => { if (!menu.contains(event.target as Node)) close(true); };
  const close = (cancelled: boolean) => {
    if (!menu.isConnected) return;
    menu.remove();
    closeCurrent = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', onBlur);
    if (cancelled) {
      if (onCancel) onCancel();
      else previous?.focus?.();
    }
  };
  const onBlur = () => close(false);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('blur', onBlur);
  closeCurrent = () => close(false);
}

const stroke = (paths: string) =>
  `<svg class="md-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const MODE_INFO: Array<{ mode: ViewMode; label: string; title: string; icon: string }> = [
  { mode: 'live', label: 'Live', title: 'Markdown renders as you type', icon: stroke('<path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z"/><path d="M9 4.5l2.5 2.5"/>') },
  { mode: 'preview', label: 'Preview', title: 'Read-only, rendered like Live', icon: stroke('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>') },
  { mode: 'source', label: 'Source', title: 'Edit the Markdown source', icon: stroke('<path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/>') },
  { mode: 'split-source-preview', label: 'Source | Preview', title: 'Source on the left, preview on the right', icon: stroke('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10M3.8 6h2.4M3.8 8h2.4M3.8 10h1.6"/>') },
  { mode: 'split-preview-source', label: 'Preview | Source', title: 'Preview on the left, source on the right', icon: stroke('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10M9.8 6h2.4M9.8 8h2.4M9.8 10h1.6"/>') },
];

/** Button showing the current mode; opens a menu with the four modes. */
export class ModeMenu {
  readonly button = document.createElement('button');

  constructor(private readonly onSelect: (mode: ViewMode) => void) {
    this.button.type = 'button';
    this.button.className = 'md-corner-button md-mode-button';
    this.button.setAttribute('aria-haspopup', 'menu');
    this.button.addEventListener('mousedown', (event) => event.preventDefault());
    this.button.addEventListener('click', () => this.open());
    this.button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); this.open(); }
    });
  }

  private mode: ViewMode = 'live';

  render(mode: ViewMode): void {
    this.mode = mode;
    const info = MODE_INFO.find((m) => m.mode === mode)!;
    this.button.innerHTML = `${info.icon}<span class="md-mode-label"></span>${stroke('<path d="M4.5 6.5 8 10l3.5-3.5"/>')}`;
    this.button.querySelector('.md-mode-label')!.textContent = t(info.label);
    this.button.title = `${t('View mode')}: ${t(info.title)}`;
    this.button.setAttribute('aria-label', `${t('View mode')}: ${t(info.label)}`);
  }

  open(): void {
    const rect = this.button.getBoundingClientRect();
    this.button.setAttribute('aria-expanded', 'true');
    openMenu(
      MODE_INFO.map((info) => ({
        label: t(info.label),
        icon: info.icon,
        checked: info.mode === this.mode,
        run: () => { this.button.setAttribute('aria-expanded', 'false'); this.onSelect(info.mode); },
      })),
      { x: rect.right, y: rect.bottom + 4, alignRight: true },
      () => { this.button.setAttribute('aria-expanded', 'false'); this.button.focus(); }
    );
  }
}

/** Literal ${filename}, not a template placeholder. */
const RELATIVE_HINT = 'Relative to the Markdown file. ' + '$' + '{filename} is the file name, e.g. ' + '$' + '{filename}.assets';

export const HISTORY_ICONS = {
  undo: stroke('<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/>'),
  redo: stroke('<path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/>'),
};

export const SETTINGS_ICON = stroke('<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>');

export interface SettingsValues { config: EditorConfig; locale: Locale; autoSaveOff: boolean }

/** Modal settings dialog; changes apply on Save and are written to VS Code settings by the host. */
export class SettingsDialog {
  private readonly dialog = document.createElement('dialog');

  constructor(private readonly onSave: (values: SettingsValues) => void, private readonly onOpenAll: () => void) {
    this.dialog.className = 'md-dialog';
    this.dialog.addEventListener('close', () => document.querySelector<HTMLElement>('.md-settings-button')?.focus());
    this.dialog.addEventListener('keydown', (event) => event.stopPropagation());
    document.body.append(this.dialog);
  }

  open(values: SettingsValues): void {
    const c = values.config;
    const option = (value: string, label: string, selected: boolean) =>
      `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
    this.dialog.innerHTML = `
      <form method="dialog" class="md-settings">
        <h2>${t('Settings')}</h2>
        <section>
          <h3>${t('Pasted images and files')}</h3>
          <label class="md-field">
            <span>${t('Save to folder')}</span>
            <input name="attachmentFolder" type="text" spellcheck="false" autocomplete="off">
            <small>${t(RELATIVE_HINT)}</small>
          </label>
          <label class="md-check">
            <input name="embedImages" type="checkbox"${c.embedImages ? ' checked' : ''}>
            <span>${t('Embed images in the Markdown as Base64 instead')}</span>
          </label>
        </section>
        <section>
          <h3>${t('Saving')}</h3>
          <label class="md-check">
            <input name="autoSaveOff" type="checkbox"${values.autoSaveOff ? ' checked' : ''}>
            <span>${t('Ask to save when closing unsaved Markdown files')}</span>
          </label>
          <small class="md-check-hint">${t('Turns off VS Code auto save for Markdown files only. Clear it to auto save Markdown like other files.')}</small>
        </section>
        <section>
          <h3>${t('Appearance')}</h3>
          <div class="md-grid2">
            <label class="md-field"><span>${t('Font size')}</span><input name="fontSize" type="number" min="10" max="32" step="1" value="${c.fontSize}"></label>
            <label class="md-field"><span>${t('Line height')}</span><input name="lineHeight" type="number" min="1" max="3" step="0.1" value="${c.lineHeight}"></label>
            <label class="md-field"><span>${t('Content width (0 = full)')}</span><input name="maxWidth" type="number" min="0" max="4000" step="20" value="${c.maxWidth}"></label>
            <label class="md-field"><span>${t('Table of contents depth')}</span><input name="tocMaxDepth" type="number" min="1" max="6" step="1" value="${c.tocMaxDepth}"></label>
            <label class="md-field"><span>${t('Diagram theme')}</span>
              <select name="mermaidTheme">
                ${option('auto', t('Follow VS Code'), c.mermaidTheme === 'auto')}
                ${option('default', 'Default', c.mermaidTheme === 'default')}
                ${option('neutral', 'Neutral', c.mermaidTheme === 'neutral')}
                ${option('dark', 'Dark', c.mermaidTheme === 'dark')}
                ${option('forest', 'Forest', c.mermaidTheme === 'forest')}
              </select>
            </label>
            <label class="md-field"><span>${t('Edit formulas and diagrams')}</span>
              <select name="blockEdit">
                ${option('doubleClick', t('Double-click'), c.blockEdit === 'doubleClick')}
                ${option('click', t('Single click'), c.blockEdit === 'click')}
              </select>
            </label>
            <label class="md-field"><span>${t('Language')}</span>
              <select name="locale">
                ${option('en', 'English', values.locale === 'en')}
                ${option('zh-CN', '简体中文', values.locale === 'zh-CN')}
              </select>
            </label>
          </div>
        </section>
        <footer>
          <button type="button" class="md-link-button" data-action="all">${t('All settings…')}</button>
          <span class="md-spacer"></span>
          <button type="button" class="md-button md-secondary" data-action="cancel">${t('Cancel')}</button>
          <button type="submit" class="md-button md-primary" value="save">${t('Save')}</button>
        </footer>
      </form>`;
    const form = this.dialog.querySelector('form')!;
    (form.elements.namedItem('attachmentFolder') as HTMLInputElement).value = c.attachmentFolder;
    form.querySelector('[data-action="cancel"]')!.addEventListener('click', () => this.dialog.close());
    form.querySelector('[data-action="all"]')!.addEventListener('click', () => { this.dialog.close(); this.onOpenAll(); });
    form.addEventListener('submit', () => {
      const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
      this.onSave({
        locale: field('locale').value === 'zh-CN' ? 'zh-CN' : 'en',
        autoSaveOff: field('autoSaveOff').checked,
        config: {
          attachmentFolder: field('attachmentFolder').value.trim() || 'assets',
          embedImages: field('embedImages').checked,
          fontSize: Number(field('fontSize').value),
          lineHeight: Number(field('lineHeight').value),
          maxWidth: Number(field('maxWidth').value),
          tocMaxDepth: Number(field('tocMaxDepth').value),
          mermaidTheme: field('mermaidTheme').value as EditorConfig['mermaidTheme'],
          blockEdit: field('blockEdit').value === 'click' ? 'click' : 'doubleClick',
        },
      });
    });
    this.dialog.showModal();
    (form.elements.namedItem('attachmentFolder') as HTMLInputElement).focus();
  }
}
