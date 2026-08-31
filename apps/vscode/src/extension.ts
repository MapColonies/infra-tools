import * as vscode from 'vscode';
import { extractImageReferences, type ImageReference, type SourceRange } from 'helm';
import { checkImageExistence, type FetchLike } from 'oci-registry';

const DIAGNOSTIC_COLLECTION_NAME = 'infra-tools-images';

// The conventional Helm values file name only. Matching any YAML file
// beneath a chart directory (and excluding its templates directory) is
// Helm chart-context knowledge this ticket doesn't implement yet.
const VALUES_FILE_NAME_PATTERN = /^values\.ya?ml$/i;

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

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      await checkImageReferencesInDocument(document, diagnostics, fetchImpl);
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
 * Extracts and checks a document's image references, then replaces its
 * diagnostics with the result. Runs on document open only — checking again
 * as the developer types, and clearing stale results when a chart's
 * `appVersion` changes, are later tickets.
 */
async function checkImageReferencesInDocument(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  fetch: FetchLike
): Promise<void> {
  if (!isHelmValuesFile(document)) {
    return;
  }

  let references: ImageReference[];
  try {
    references = extractImageReferences(document.getText());
  } catch {
    // A YAML syntax error is the YAML language service's diagnostic to
    // raise, not this feature's — stay silent rather than compete with it.
    return;
  }

  const checks = await Promise.all(
    references.map(async (reference) => ({
      reference,
      verdict: await checkImageExistence({
        repository: reference.repository.text,
        tag: reference.tag.text,
        fetch,
      }),
    }))
  );

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

  diagnostics.set(document.uri, fileDiagnostics);
}

function rangeOf(document: vscode.TextDocument, range: SourceRange): vscode.Range {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}

export { activate, deactivate };
