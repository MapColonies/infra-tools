import * as vscode from 'vscode';
import type { ReferenceCheck } from './reference-check';
import { rangeOf } from './source-range';

/**
 * The diagnostics a document's checks call for. Only the two not-found
 * verdicts qualify: that an unverifiable verdict never renders as an error
 * is the one invariant this feature must not break, because an expired token
 * or an unreachable registry must never look like a missing image.
 */
function diagnosticsFor(document: vscode.TextDocument, checks: readonly ReferenceCheck[]): vscode.Diagnostic[] {
  const fileDiagnostics: vscode.Diagnostic[] = [];

  for (const { reference, verdict } of checks) {
    if (verdict.kind === 'repository-not-found') {
      fileDiagnostics.push(
        new vscode.Diagnostic(
          rangeOf(document, reference.repository.range),
          `Repository '${verdict.repository}' not found.`,
          vscode.DiagnosticSeverity.Error
        )
      );
    } else if (verdict.kind === 'tag-not-found') {
      fileDiagnostics.push(
        new vscode.Diagnostic(
          // Unreachable fallback: only a reference that named a tag can come
          // back tag-not-found. It keeps the type honest without an assertion.
          rangeOf(document, reference.tag?.range ?? reference.repository.range),
          `Tag '${verdict.tag}' not found in '${verdict.repository}'.`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  return fileDiagnostics;
}

export { diagnosticsFor };
