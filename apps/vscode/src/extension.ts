import * as vscode from 'vscode';
import { localDockerCredentials, type CredentialEnvironment, type FetchLike } from 'oci-registry';
import { diagnosticsFor } from './diagnostics';
import { hoverFor } from './hover';
import { createLoginPrompts } from './login-prompts';
import { applyMarks, createMarkDecorationType } from './marks';
import { checkImageReferencesInDocument, checksAsOf, registriesNeedingLogin, type DocumentChecks } from './reference-check';

const DIAGNOSTIC_COLLECTION_NAME = 'infra-tools-images';

interface ActivateDependencies {
  /** Only tests override this; production activation uses the platform's `fetch`. */
  readonly fetch?: FetchLike;
  /** Only tests override this; production activation reads the developer's real Docker config. */
  readonly credentials?: CredentialEnvironment;
}

/**
 * Called by the extension host on activation. Wires the three surfaces a
 * check is shown on and re-checks a Helm values file whenever one opens.
 */
function activate(context: vscode.ExtensionContext, dependencies: ActivateDependencies = {}): void {
  const channel = vscode.window.createOutputChannel('Infra Tools');
  channel.appendLine('Infra Tools extension activated.');
  context.subscriptions.push(channel);

  const checkDependencies = {
    fetch: dependencies.fetch ?? (globalThis as unknown as { fetch: FetchLike }).fetch,
    credentials: dependencies.credentials ?? localDockerCredentials,
  };
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME);
  context.subscriptions.push(diagnostics);

  const checksByDocument = new Map<string, DocumentChecks>();
  const markDecorationType = createMarkDecorationType();
  context.subscriptions.push(markDecorationType);

  const loginPrompts = createLoginPrompts(context.globalState);
  context.subscriptions.push(loginPrompts);

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async (document) => {
      // VS Code never awaits a listener, so anything escaping this callback
      // is an unhandled rejection, and that takes the extension host down.
      try {
        const checked = await checkImageReferencesInDocument(document, checkDependencies);

        if (checked === undefined) {
          return;
        }

        checksByDocument.set(document.uri.toString(), checked);
        diagnostics.set(document.uri, diagnosticsFor(document, checksAsOf(checked, document)));
        applyMarks(vscode.window.visibleTextEditors, checksByDocument, markDecorationType);

        // Not awaited: a notification stays up until the developer answers
        // it, and holding an open-document listener for that long would tie
        // this file's check to a dialog about a registry.
        void loginPrompts.report(registriesNeedingLogin(checked.checks));
      } catch (error) {
        channel.appendLine(`Checking image references in ${document.uri.toString()} failed: ${String(error)}`);
      }
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
