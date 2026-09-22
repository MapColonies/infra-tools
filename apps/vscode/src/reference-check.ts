import type * as vscode from 'vscode';
import { extractImageReferences, resolveTag, resolveValuesFileContext, type ImageReference, type ReadTextFile, type ResolvedTag } from 'helm';
import { checkImageExistence, type CredentialEnvironment, type FetchLike, type ImageVerdict } from 'oci-registry';

/**
 * One checked reference, projected onto all three surfaces, so diagnostics,
 * marks, and hovers can never disagree about a reference.
 *
 * The resolved tag rides along because it is not always in the file: a tag
 * taken from `appVersion` has a chart to name and no range to underline, and
 * both of those are decisions a surface has to make per reference.
 */
interface ReferenceCheck {
  readonly reference: ImageReference;
  readonly tag: ResolvedTag;
  readonly verdict: ImageVerdict;
}

/** A document's checks, tagged with the document version they describe. */
interface DocumentChecks {
  readonly version: number;
  readonly checks: readonly ReferenceCheck[];
  /** The metadata file whose `appVersion` these checks may depend on. */
  readonly chartMetadataPath: string | undefined;
}

interface CheckDependencies {
  readonly fetch: FetchLike;
  readonly credentials: CredentialEnvironment;
  readonly readTextFile: ReadTextFile;
}

/**
 * Checks a document's image references. `undefined` means this feature has
 * nothing to say about the document at all, which is not the same as a
 * checked document that produced no findings: the caller replaces a
 * document's diagnostics and marks only when it gets checks back.
 *
 * Which documents those are is the Helm package's call, not this file's — a
 * values file is anything beneath a chart directory, and that is chart
 * knowledge a future CLI would otherwise have to reimplement.
 */
async function checkImageReferencesInDocument(document: vscode.TextDocument, dependencies: CheckDependencies): Promise<DocumentChecks | undefined> {
  if (document.languageId !== 'yaml') {
    return undefined;
  }

  const { fetch, credentials, readTextFile } = dependencies;
  const context = await resolveValuesFileContext(document.uri.path, readTextFile);

  if (context === undefined) {
    return undefined;
  }

  const version = document.version;

  // No guard around this: the extractor collects YAML syntax errors rather
  // than throwing, so a malformed file yields whatever it could salvage. The
  // open listener's own catch covers a genuine fault.
  const references = extractImageReferences(document.getText());

  // A reference that resolves to no tag at all is dropped here rather than
  // carried as an outcome: there is nothing to ask a registry and nothing
  // truthful to render, and a mark that says only "unchecked" on a file the
  // developer cannot act on is noise they would switch the feature off over.
  const resolved = references.flatMap((reference) => {
    const tag = resolveTag(reference, context.chart);

    return tag === undefined ? [] : [{ reference, tag }];
  });

  const checks = await Promise.all(
    resolved.map(async ({ reference, tag }) => ({
      reference,
      tag,
      verdict: await checkImageExistence({
        repository: reference.repository.text,
        tag: tag.text,
        declaredRegistry: reference.registry,
        fetch,
        credentials,
      }),
    }))
  );

  return { version, checks, chartMetadataPath: context.chart?.path };
}

/**
 * A document's checks, or none once the text has moved on. Recorded offsets
 * belong to the version that was checked, so projecting them onto edited
 * text would slide a mark onto whatever now sits at that offset.
 */
function checksAsOf(checked: DocumentChecks, document: vscode.TextDocument): readonly ReferenceCheck[] {
  return checked.version === document.version ? checked.checks : [];
}

/**
 * The distinct registries a document's checks could not reach for want of a
 * login.
 *
 * Deduplicated here rather than by the caller, because a values file naming
 * ten images on one private registry is the ordinary case, and ten identical
 * prompts for it would be the feature's worst behaviour.
 */
function registriesNeedingLogin(checks: readonly ReferenceCheck[]): string[] {
  const registries = new Set<string>();

  for (const { verdict } of checks) {
    if (verdict.kind === 'unverifiable' && verdict.reason === 'needs-login') {
      registries.add(verdict.registry);
    }
  }

  return [...registries];
}

export { checkImageReferencesInDocument, checksAsOf, registriesNeedingLogin };
export type { DocumentChecks, ReferenceCheck };
