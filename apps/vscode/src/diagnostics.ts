import * as vscode from 'vscode';
import type { ReferenceCheck } from './reference-check';
import { rangeOf } from './source-range';
import { chartProvenanceSentence } from './tag-provenance';

/**
 * The diagnostics a document's checks call for. Only the two not-found
 * verdicts qualify: that an unverifiable verdict never renders as an error
 * is the one invariant this feature must not break, because an expired token
 * or an unreachable registry must never look like a missing image.
 *
 * `describeChartPath` shortens a chart metadata path for display — an
 * absolute path in the Problems panel is noise the reader has to scan past.
 */
function diagnosticsFor(
  document: vscode.TextDocument,
  checks: readonly ReferenceCheck[],
  describeChartPath: (path: string) => string
): vscode.Diagnostic[] {
  const fileDiagnostics: vscode.Diagnostic[] = [];

  for (const { reference, tag, verdict } of checks) {
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
          // A tag taken from chart metadata has no text in this file to
          // underline, so the squiggle goes on the repository it applies to
          // and the message points at the chart instead of leaving the
          // reader hunting for a tag that was never written here.
          rangeOf(document, tag.source === 'file' ? tag.range : reference.repository.range),
          `Tag '${verdict.tag}' not found in '${verdict.repository}'.${chartProvenanceSentence(tag, describeChartPath)}`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  return fileDiagnostics;
}

export { diagnosticsFor };
