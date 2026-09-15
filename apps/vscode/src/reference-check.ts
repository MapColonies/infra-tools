import type * as vscode from 'vscode';
import { extractImageReferences, type ImageReference } from 'helm';
import { checkImageExistence, type FetchLike, type ImageVerdict, type UnverifiableReason } from 'oci-registry';

// Matching any YAML file beneath a chart directory, and excluding that
// chart's templates directory, is Helm chart-context knowledge this ticket
// doesn't implement yet.
const VALUES_FILE_NAME_PATTERN = /^values\.ya?ml$/i;

/** Every reason the registry package reports, plus the ones settled before asking it. */
type UncheckedReason = UnverifiableReason | 'no-tag';

type ReferenceVerdict = Exclude<ImageVerdict, { kind: 'unverifiable' }> | { readonly kind: 'unverifiable'; readonly reason: UncheckedReason };

/**
 * One checked reference, projected onto all three surfaces, so diagnostics,
 * marks, and hovers can never disagree about a reference.
 */
interface ReferenceCheck {
  readonly reference: ImageReference;
  readonly verdict: ReferenceVerdict;
}

/** A document's checks, tagged with the document version they describe. */
interface DocumentChecks {
  readonly version: number;
  readonly checks: readonly ReferenceCheck[];
}

function isHelmValuesFile(document: vscode.TextDocument): boolean {
  if (document.languageId !== 'yaml') {
    return false;
  }

  const fileName = document.uri.path.split('/').pop() ?? '';

  return VALUES_FILE_NAME_PATTERN.test(fileName);
}

/**
 * Checks a document's image references. `undefined` means this feature has
 * nothing to say about the document at all, which is not the same as a
 * checked document that produced no findings: the caller replaces a
 * document's diagnostics and marks only when it gets checks back.
 */
async function checkImageReferencesInDocument(document: vscode.TextDocument, fetch: FetchLike): Promise<DocumentChecks | undefined> {
  if (!isHelmValuesFile(document)) {
    return undefined;
  }

  const version = document.version;

  // No guard around this: the extractor collects YAML syntax errors rather
  // than throwing, so a malformed file yields whatever it could salvage. The
  // open listener's own catch covers a genuine fault.
  const references = extractImageReferences(document.getText());

  // A tagless reference has nothing to ask a registry until `appVersion`
  // resolution lands, but it still comes through as a check. Dropping it is
  // what made real references render nothing, which reads as a broken tool.
  const checks = await Promise.all(
    references.map(async (reference) => ({
      reference,
      verdict:
        reference.tag === undefined
          ? ({ kind: 'unverifiable', reason: 'no-tag' } as const)
          : await checkImageExistence({ repository: reference.repository.text, tag: reference.tag.text, fetch }),
    }))
  );

  return { version, checks };
}

/**
 * A document's checks, or none once the text has moved on. Recorded offsets
 * belong to the version that was checked, so projecting them onto edited
 * text would slide a mark onto whatever now sits at that offset.
 */
function checksAsOf(checked: DocumentChecks, document: vscode.TextDocument): readonly ReferenceCheck[] {
  return checked.version === document.version ? checked.checks : [];
}

export { checkImageReferencesInDocument, checksAsOf, isHelmValuesFile };
export type { DocumentChecks, ReferenceCheck, ReferenceVerdict, UncheckedReason };
