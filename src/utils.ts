import * as vscode from 'vscode';

export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const asset = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', ...segments));
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data: blob:`,
    // CodeMirror and Mermaid inject style elements at runtime.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    // Mermaid is loaded on demand from the extension's dist folder.
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${asset('katex', 'katex.min.css')}">
  <link rel="stylesheet" href="${asset('webview.css')}">
  <title>Neat MD</title>
</head>
<body data-mermaid="${asset('mermaid.min.js')}">
  <div id="root"></div>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}
