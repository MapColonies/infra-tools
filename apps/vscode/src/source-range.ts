import * as vscode from 'vscode';
import type { SourceRange } from 'helm';

function rangeOf(document: vscode.TextDocument, range: SourceRange): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}

function containsOffset(range: SourceRange, offset: number): boolean {
  return offset >= range.start && offset < range.end;
}

export { containsOffset, rangeOf };
