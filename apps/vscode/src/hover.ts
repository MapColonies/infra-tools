import * as vscode from 'vscode';
import type { ReferenceCheck, UncheckedReason } from './reference-check';
import { containsOffset } from './source-range';

// A table rather than a switch, so adding a reason fails the build here
// instead of hovering with no explanation.
const UNCHECKED_REASON_TEXT: Record<UncheckedReason, string> = {
  'no-tag': 'the reference names no tag to check.',
  'no-registry': 'the repository names no registry host.',
  'needs-login': 'no local Docker credential for that registry. Run `docker login` against it.',
  'authentication-failure': 'the registry refused the local Docker credential for it.',
  'network-error': 'the registry could not be reached.',
  'unexpected-response': 'the registry answered in a form this extension does not understand.',
  'malformed-reference': 'the tag is not a valid OCI tag.',
};

/**
 * What hovering a checked reference reports. A not-found verdict gets no
 * hover: it already speaks through its diagnostic, and it names no registry.
 */
function hoverFor(document: vscode.TextDocument, position: vscode.Position, checks: readonly ReferenceCheck[]): vscode.Hover | undefined {
  const offset = document.offsetAt(position);
  const check = checks.find(
    ({ reference }) =>
      containsOffset(reference.repository.range, offset) || (reference.tag !== undefined && containsOffset(reference.tag.range, offset))
  );

  if (check === undefined) {
    return undefined;
  }

  const { verdict } = check;

  if (verdict.kind === 'exists') {
    return new vscode.Hover(new vscode.MarkdownString(`Verified on \`${verdict.registry}\`.`));
  }

  if (verdict.kind === 'unverifiable') {
    return new vscode.Hover(new vscode.MarkdownString(`Not verified: ${UNCHECKED_REASON_TEXT[verdict.reason]}`));
  }

  return undefined;
}

export { hoverFor };
