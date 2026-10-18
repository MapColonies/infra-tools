import * as vscode from 'vscode';

/** Builds a fake `vscode.TextDocument`, with a real `positionAt`/`offsetAt` pair so range assertions are exact. */
function createFakeDocument(path: string, initialText: string, languageId = 'yaml'): vscode.TextDocument {
  let text = initialText;

  return {
    uri: { path, toString: () => path },
    languageId,
    version: 1,
    getText: () => text,
    // Test-only: not part of the real API. Use `editDocument` rather than calling it.
    replaceText: (edited: string) => {
      text = edited;
    },
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const lines = before.split('\n');
      const line = lines.length - 1;
      const character = lines[lines.length - 1]?.length ?? 0;

      return new vscode.Position(line, character);
    },
    offsetAt: (position: vscode.Position) => {
      const lines = text.split('\n');
      let offset = 0;

      for (let line = 0; line < position.line; line += 1) {
        offset += (lines[line]?.length ?? 0) + '\n'.length;
      }

      return offset + position.character;
    },
  } as unknown as vscode.TextDocument;
}

/** Simulates an edit: VS Code bumps a document's `version` on every change. */
function bumpVersion(document: vscode.TextDocument): void {
  (document as { version: number }).version += 1;
}

/** Simulates typing: replaces the whole text and bumps the version, as VS Code does before firing a change event. */
function editDocument(document: vscode.TextDocument, text: string): void {
  (document as unknown as { replaceText: (edited: string) => void }).replaceText(text);
  bumpVersion(document);
}

export { bumpVersion, createFakeDocument, editDocument };
