import * as vscode from 'vscode';
import type { ReadTextFile } from 'helm';
import { localDockerCredentials, type CredentialEnvironment, type FetchLike } from 'oci-registry';
import { diagnosticsFor } from './diagnostics';
import { hoverFor } from './hover';
import { createLoginPrompts } from './login-prompts';
import { applyMarks, createMarkDecorationType } from './marks';
import { checkImageReferencesInDocument, checksAsOf, registriesNeedingLogin, type DocumentChecks } from './reference-check';

const DIAGNOSTIC_COLLECTION_NAME = 'infra-tools-images';

// Both spellings, because chart resolution accepts both and a watcher that
// covered only one would leave half the charts in a workspace unwatched.
const CHART_METADATA_GLOB = '**/Chart.{yaml,yml}';

interface ActivateDependencies {
  /** Only tests override this; production activation uses the platform's `fetch`. */
  readonly fetch?: FetchLike;
  /** Only tests override this; production activation reads the developer's real Docker config. */
  readonly credentials?: CredentialEnvironment;
  /** Only tests override this; production activation reads through the workspace file system. */
  readonly readTextFile?: ReadTextFile;
}

/**
 * Reads a workspace file as text, through VS Code's file system rather than
 * Node's, so a remote workspace resolves its charts on the machine the
 * extension host actually runs on. `Uri.file` pins the scheme to `file`, so
 * a virtual workspace — a repository browsed without being cloned — resolves
 * no charts at all and falls back to the values-file naming rule.
 *
 * A read that throws is reported as nothing readable rather than as a
 * failure: chart resolution asks about `Chart.yaml` in every ancestor
 * directory of a file, so absent is the ordinary answer, not an error.
 */
async function readWorkspaceTextFile(path: string): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path)));
  } catch {
    return undefined;
  }
}

/**
 * Called by the extension host on activation. Wires the three surfaces a
 * check is shown on, re-checks a Helm values file whenever one opens, and
 * re-checks the files a chart governs whenever its metadata changes.
 */
function activate(context: vscode.ExtensionContext, dependencies: ActivateDependencies = {}): void {
  const channel = vscode.window.createOutputChannel('Infra Tools');
  channel.appendLine('Infra Tools extension activated.');
  context.subscriptions.push(channel);

  const checkDependencies = {
    fetch: dependencies.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch,
    credentials: dependencies.credentials ?? localDockerCredentials,
    readTextFile: dependencies.readTextFile ?? readWorkspaceTextFile,
  };
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME);
  context.subscriptions.push(diagnostics);

  const checksByDocument = new Map<string, DocumentChecks>();
  const markDecorationType = createMarkDecorationType();
  context.subscriptions.push(markDecorationType);

  const loginPrompts = createLoginPrompts(context.globalState);
  context.subscriptions.push(loginPrompts);

  /**
   * Checks one document and republishes everything shown for it. The open
   * listener and the chart watcher both go through here, so the two can
   * never drift into publishing different things about the same document.
   */
  async function checkDocument(document: vscode.TextDocument): Promise<void> {
    // VS Code never awaits a listener, so anything escaping this callback
    // is an unhandled rejection, and that takes the extension host down.
    try {
      const checked = await checkImageReferencesInDocument(document, checkDependencies);

      if (checked === undefined) {
        return;
      }

      checksByDocument.set(document.uri.toString(), checked);
      diagnostics.set(document.uri, diagnosticsFor(document, checksAsOf(checked, document), vscode.workspace.asRelativePath));
      applyMarks(vscode.window.visibleTextEditors, checksByDocument, markDecorationType);

      // Not awaited: a notification stays up until the developer answers
      // it, and holding an open-document listener for that long would tie
      // this file's check to a dialog about a registry.
      void loginPrompts.report(registriesNeedingLogin(checked.checks));
    } catch (error) {
      channel.appendLine(`Checking image references in ${document.uri.toString()} failed: ${String(error)}`);
    }
  }

  /**
   * Re-checks every open document whose last check read this metadata file.
   * A bumped `appVersion` otherwise leaves a stale checkmark standing at
   * exactly the moment the developer is relying on it.
   */
  async function recheckDocumentsGovernedBy(uri: vscode.Uri): Promise<void> {
    for (const document of vscode.workspace.textDocuments) {
      if (checksByDocument.get(document.uri.toString())?.chartMetadataPath === uri.path) {
        await checkDocument(document);
      }
    }
  }

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(checkDocument));

  const chartMetadataWatcher = vscode.workspace.createFileSystemWatcher(CHART_METADATA_GLOB);
  context.subscriptions.push(chartMetadataWatcher);
  context.subscriptions.push(chartMetadataWatcher.onDidChange(recheckDocumentsGovernedBy));
  context.subscriptions.push(chartMetadataWatcher.onDidCreate(recheckDocumentsGovernedBy));

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { language: 'yaml' },
      {
        provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
          const checked = checksByDocument.get(document.uri.toString());

          return checked === undefined ? undefined : hoverFor(document, position, checksAsOf(checked, document), vscode.workspace.asRelativePath);
        },
      }
    )
  );

  // A document can be checked before its editor is visible, and tab switches
  // hand out editors carrying no decorations yet.
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      applyMarks(editors, checksByDocument, markDecorationType);
    })
  );
}

function deactivate(): void {
  // Nothing to clean up yet.
}

export { activate, deactivate };
