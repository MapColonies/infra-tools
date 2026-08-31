import * as vscode from 'vscode';

/**
 * Called by the extension host when the extension activates. There are no
 * features yet — this only proves the extension loads and activates.
 */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Infra Tools');
  channel.appendLine('Infra Tools extension activated.');
  context.subscriptions.push(channel);
}

export function deactivate(): void {
  // Nothing to clean up yet.
}
