import * as vscode from 'vscode';
import { extractImageReferences, type ImageReference, type SourceRange } from 'helm';
import { checkImageExistence, resolveExplicitHost, type FetchLike, type ImageVerdict, type UnverifiableReason } from 'oci-registry';

const DIAGNOSTIC_COLLECTION_NAME = 'infra-tools-images';

const CHECKMARK = '✓';

// A table rather than a switch, so adding a reason to `UnverifiableReason`
// fails the build here instead of silently hovering with no explanation.
const UNVERIFIABLE_REASON_TEXT: Record<UnverifiableReason, string> = {
  'no-registry': 'the repository names no registry host.',
  'missing-credential': 'the registry requires credentials this extension cannot supply yet.',
  'network-error': 'the registry could not be reached.',
  'unexpected-response': 'the registry answered in a form this extension does not understand.',
  'malformed-reference': 'the tag is not a valid OCI tag.',
};

// The conventional Helm values file name only. Matching any YAML file
// beneath a chart directory (and excluding its templates directory) is
// Helm chart-context knowledge this ticket doesn't implement yet.
const VALUES_FILE_NAME_PATTERN = /^values\.ya?ml$/i;

/** An image reference that names a tag, the only kind this feature checks today. */
type TaggedImageReference = ImageReference & { readonly tag: NonNullable<ImageReference['tag']> };

/**
 * One checked image reference. Built once per document open, then projected
 * onto every surface the result is shown on — diagnostics, checkmarks, and
 * hovers — so the three can never disagree about a reference.
 */
interface ReferenceCheck {
  readonly reference: TaggedImageReference;
  readonly verdict: ImageVerdict;
}

/** A document's checks, tagged with the document version they describe. */
interface DocumentChecks {
  readonly version: number;
  readonly checks: readonly ReferenceCheck[];
}

interface ActivateDependencies {
  /**
   * The fetch implementation existence checks use. Defaults to the
   * platform's global `fetch`; only tests have a reason to override it —
   * production activation never does.
   */
  readonly fetch?: FetchLike;
}

/**
 * Called by the extension host when the extension activates. Registers a
 * diagnostics collection and checks a Helm values file's image references
 * against their registries whenever one is opened.
 */
function activate(context: vscode.ExtensionContext, dependencies: ActivateDependencies = {}): void {
  const channel = vscode.window.createOutputChannel('Infra Tools');
  channel.appendLine('Infra Tools extension activated.');
  context.subscriptions.push(channel);

  const fetchImpl = dependencies.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME);
  context.subscriptions.push(diagnostics);

  const checksByDocument = new Map<string, DocumentChecks>();

  // `contentText` is per-decoration because it names the answering registry
  // when that differs from the host the file names; everything shared lives
  // on the one type.
  const checkmarkDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('charts.green'),
      margin: '0 0 0 0.5em',
    },
  });
  context.subscriptions.push(checkmarkDecorationType);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      const checked = await checkImageReferencesInDocument(document, fetchImpl);

      if (checked === undefined) {
        return;
      }

      checksByDocument.set(document.uri.toString(), checked);
      diagnostics.set(document.uri, diagnosticsFor(document, checksAsOf(checked, document)));
      applyCheckmarks(vscode.window.visibleTextEditors, checksByDocument, checkmarkDecorationType);
    })
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { language: 'yaml' },
      {
        provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
          const checked = checksByDocument.get(document.uri.toString());

          return checked === undefined ? undefined : hoverFor(document, position, checksAsOf(checked, document));
        },
      }
    )
  );

  // A document can be checked before its editor is visible, and split view
  // and tab switches hand out editors that carry no decorations yet, so the
  // stored checks are re-applied whenever the visible set changes.
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      applyCheckmarks(editors, checksByDocument, checkmarkDecorationType);
    })
  );
}

function deactivate(): void {
  // Nothing to clean up yet.
}

/** Whether a document is the conventional Helm values file. */
function isHelmValuesFile(document: vscode.TextDocument): boolean {
  if (document.languageId !== 'yaml') {
    return false;
  }

  const fileName = document.uri.path.split('/').pop() ?? '';

  return VALUES_FILE_NAME_PATTERN.test(fileName);
}

/**
 * Extracts and checks a document's image references. Returns `undefined` for
 * a document this feature has nothing to say about, which is not the same as
 * a checked document that produced no findings — the caller replaces a
 * document's diagnostics and decorations only when it gets an array back.
 * Runs on document open only — checking again as the developer types, and
 * clearing stale results when a chart's `appVersion` changes, are later
 * tickets.
 */
async function checkImageReferencesInDocument(document: vscode.TextDocument, fetch: FetchLike): Promise<DocumentChecks | undefined> {
  if (!isHelmValuesFile(document)) {
    return undefined;
  }

  const version = document.version;

  let references: ImageReference[];
  try {
    references = extractImageReferences(document.getText());
  } catch {
    // A YAML syntax error is the YAML language service's diagnostic to
    // raise, not this feature's — stay silent rather than compete with it.
    return undefined;
  }

  // A tagless reference resolves through `appVersion`, a later ticket's job —
  // nothing to check yet.
  const taggedReferences = references.filter((reference): reference is TaggedImageReference => reference.tag !== undefined);

  const checks = await Promise.all(
    taggedReferences.map(async (reference) => ({
      reference,
      verdict: await checkImageExistence({
        repository: reference.repository.text,
        tag: reference.tag.text,
        fetch,
      }),
    }))
  );

  return { version, checks };
}

/**
 * A document's checks, or none when the text has moved on since they were
 * taken. The recorded offsets belong to the version that was checked;
 * projecting them onto edited text would slide a checkmark onto whatever now
 * sits at that offset. Nothing is the honest answer until the next check.
 */
function checksAsOf(checked: DocumentChecks, document: vscode.TextDocument): readonly ReferenceCheck[] {
  return checked.version === document.version ? checked.checks : [];
}

/** The diagnostics a document's checks call for. */
function diagnosticsFor(document: vscode.TextDocument, checks: readonly ReferenceCheck[]): vscode.Diagnostic[] {
  const fileDiagnostics: vscode.Diagnostic[] = [];

  for (const { reference, verdict } of checks) {
    // 'exists' and 'unverifiable' both produce no diagnostic. That an
    // unverifiable verdict never renders as an error is the one invariant
    // this feature must never break — an expired token or an unreachable
    // registry must never look like a missing image.
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
          rangeOf(document, reference.tag.range),
          `Tag '${verdict.tag}' not found in '${verdict.repository}'.`,
          vscode.DiagnosticSeverity.Error
        )
      );
    }
  }

  return fileDiagnostics;
}

/**
 * The checkmarks a document's checks call for: one per reference that
 * exists, and nothing at all for any other verdict — an unverifiable
 * reference is not confirmation.
 */
function checkmarksFor(document: vscode.TextDocument, checks: readonly ReferenceCheck[]): vscode.DecorationOptions[] {
  const decorations: vscode.DecorationOptions[] = [];

  for (const { reference, verdict } of checks) {
    if (verdict.kind !== 'exists') {
      continue;
    }

    // Naming the registry only when it differs from the one the file names
    // keeps the annotation informative instead of restating the line. Today
    // it can never differ; the registry override set that makes it possible
    // is a later ticket.
    const namedHost = resolveExplicitHost(reference.repository.text)?.host;
    const contentText = verdict.registry === namedHost ? ` ${CHECKMARK}` : ` ${CHECKMARK} ${verdict.registry}`;

    decorations.push({
      range: rangeOf(document, reference.repository.range),
      renderOptions: { after: { contentText } },
    });
  }

  return decorations;
}

/**
 * Re-applies each editor's stored checkmarks. An editor showing a checked
 * document always gets a `setDecorations` call, empty array included, so a
 * reference that stops verifying loses the checkmark it used to have.
 */
function applyCheckmarks(
  editors: readonly vscode.TextEditor[],
  checksByDocument: ReadonlyMap<string, DocumentChecks>,
  decorationType: vscode.TextEditorDecorationType
): void {
  for (const editor of editors) {
    const checked = checksByDocument.get(editor.document.uri.toString());

    if (checked !== undefined) {
      editor.setDecorations(decorationType, checkmarksFor(editor.document, checksAsOf(checked, editor.document)));
    }
  }
}

/**
 * What hovering a position in a checked document reports: the registry that
 * confirmed the reference, or why it could not be checked. A not-found
 * verdict gets no hover — it already speaks through its diagnostic, and it
 * names no registry to report.
 */
function hoverFor(document: vscode.TextDocument, position: vscode.Position, checks: readonly ReferenceCheck[]): vscode.Hover | undefined {
  const offset = document.offsetAt(position);
  const check = checks.find(({ reference }) => containsOffset(reference.repository.range, offset) || containsOffset(reference.tag.range, offset));

  if (check === undefined) {
    return undefined;
  }

  const { verdict } = check;

  if (verdict.kind === 'exists') {
    return new vscode.Hover(new vscode.MarkdownString(`Verified on \`${verdict.registry}\`.`));
  }

  if (verdict.kind === 'unverifiable') {
    return new vscode.Hover(new vscode.MarkdownString(`Not verified: ${UNVERIFIABLE_REASON_TEXT[verdict.reason]}`));
  }

  return undefined;
}

function containsOffset(range: SourceRange, offset: number): boolean {
  return offset >= range.start && offset < range.end;
}

function rangeOf(document: vscode.TextDocument, range: SourceRange): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}

export { activate, deactivate };
