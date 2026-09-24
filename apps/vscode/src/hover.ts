import * as vscode from 'vscode';
import type { UnverifiableReason } from 'oci-registry';
import type { ReferenceCheck } from './reference-check';
import { containsOffset } from './source-range';
import { chartProvenanceSentence } from './tag-provenance';

// A table rather than a switch, so adding a reason fails the build here
// instead of hovering with no explanation.
const UNCHECKED_REASON_TEXT: Record<UnverifiableReason, string> = {
  'guessed-registry': 'nothing here names a registry, and Docker Hub — the only one left to try — does not have it.',
  'needs-login': 'no local Docker credential for that registry. Run `docker login` against it.',
  'authentication-failure': 'the registry refused the local Docker credential for it.',
  'network-error': 'the registry could not be reached.',
  'unexpected-response': 'the registry answered in a form this extension does not understand.',
  'malformed-reference': 'the reference is not a valid image reference.',
};

/**
 * What hovering a checked reference reports. A not-found verdict gets no
 * hover: it already speaks through its diagnostic, and it names no registry.
 *
 * A reference checked against a tag it never wrote is told so here as well
 * as in the diagnostic, because a hover is the only surface a verified
 * reference has, and a checkmark earned by someone else's tag is worth
 * knowing about.
 */
function hoverFor(
  document: vscode.TextDocument,
  position: vscode.Position,
  checks: readonly ReferenceCheck[],
  describeChartPath: (path: string) => string
): vscode.Hover | undefined {
  const offset = document.offsetAt(position);
  const check = checks.find(
    ({ reference }) =>
      containsOffset(reference.repository.range, offset) || (reference.tag !== undefined && containsOffset(reference.tag.range, offset))
  );

  if (check === undefined) {
    return undefined;
  }

  const { tag, verdict } = check;
  const provenance = chartProvenanceSentence(tag, describeChartPath);

  if (verdict.kind === 'exists') {
    return new vscode.Hover(new vscode.MarkdownString(`Verified on \`${verdict.registry}\`.${provenance}`));
  }

  if (verdict.kind === 'unverifiable') {
    return new vscode.Hover(new vscode.MarkdownString(`Not verified: ${UNCHECKED_REASON_TEXT[verdict.reason]}${provenance}`));
  }

  return undefined;
}

export { hoverFor };
