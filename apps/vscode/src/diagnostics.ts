import * as vscode from 'vscode';
import type { ReferenceCheck } from './reference-check';
import { rangeOf } from './source-range';
import { chartProvenanceSentence } from './tag-provenance';

/**
 * The sentence a not-found owes the reader when the registry override set
 * redirected the check. The Problems panel strips the inline mark away, so
 * without this a squiggle on a line naming production reads as though
 * production was checked.
 */
function overrideSentence(overrideRegistries: readonly string[] | undefined): string {
  return overrideRegistries === undefined ? '' : ` Registry override in effect: checked only ${overrideRegistries.join(', ')}.`;
}

/** The one tag the floating-tag warning knows. A list of patterns waits for a second real example. */
const LATEST_TAG = 'latest';

interface DiagnosticsOptions {
  /**
   * Shortens a chart metadata path for display — an absolute path in the
   * Problems panel is noise the reader has to scan past.
   */
  readonly describeChartPath: (path: string) => string;
  /** Whether a tag pinned to `latest` in the file earns a warning. */
  readonly warnOnLatestTag: boolean;
}

/**
 * The diagnostics a document's checks call for.
 *
 * Errors come only from the two not-found verdicts: that an unverifiable
 * verdict never renders as an error is the one invariant this feature must
 * not break, because an expired token or an unreachable registry must never
 * look like a missing image.
 *
 * A tag written as `latest` also earns a warning, whatever the registry
 * said. That is an opinion about the file rather than a fact about a
 * registry, so it is warning severity, and a missing `latest` carries both
 * markers on the same range rather than one masking the other. A `latest`
 * taken from chart metadata earns none: this file pins nothing. Nor does
 * `latest@sha256:…`, whose digest already stops what deploys from drifting.
 */
function diagnosticsFor(document: vscode.TextDocument, checks: readonly ReferenceCheck[], options: DiagnosticsOptions): vscode.Diagnostic[] {
  const { describeChartPath, warnOnLatestTag } = options;
  const fileDiagnostics: vscode.Diagnostic[] = [];

  for (const { reference, tag, verdict } of checks) {
    if (warnOnLatestTag && tag.source === 'file' && tag.text === LATEST_TAG) {
      fileDiagnostics.push(
        new vscode.Diagnostic(
          rangeOf(document, tag.range),
          `Image '${reference.repository.text}' is pinned to the '${LATEST_TAG}' tag, so what deploys can change without this file changing.`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }

    if (verdict.kind === 'repository-not-found') {
      fileDiagnostics.push(
        new vscode.Diagnostic(
          rangeOf(document, reference.repository.range),
          `Repository '${verdict.repository}' not found.${overrideSentence(verdict.overrideRegistries)}`,
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
          `Tag '${verdict.tag}' not found in '${verdict.repository}'.${chartProvenanceSentence(tag, describeChartPath)}${overrideSentence(verdict.overrideRegistries)}`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  return fileDiagnostics;
}

export { diagnosticsFor };
