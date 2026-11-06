import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './MarkdownEditorProvider';

const VIEW_TYPE = 'neat-md.editor';

export function activate(context: vscode.ExtensionContext) {
  const provider = new MarkdownEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      // One editor per document keeps the editor's undo history and VS Code's undo stack in step.
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('neat-md.open', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('neat-md.openAsText', async (uri?: vscode.Uri) => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      const input = tab?.input;
      const target = uri ?? (input instanceof vscode.TabInputCustom ? input.uri : undefined);
      if (!target) return;
      // The text editor reads the file from disk, so unsaved Neat MD edits must be saved first.
      if (tab?.isDirty) {
        const save = 'Save and Reopen';
        const choice = await vscode.window.showWarningMessage('Save your changes before reopening as text?', { modal: true }, save);
        if (choice !== save) return;
        await vscode.commands.executeCommand('workbench.action.files.save');
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    })
  );
}

export function deactivate() {}
