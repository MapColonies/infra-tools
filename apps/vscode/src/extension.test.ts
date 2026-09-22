import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeContext } from '../test/fake-context';
import { noDockerCredentials } from '../test/fake-credentials';
import { bumpVersion, createFakeDocument } from '../test/fake-document';
import { createFakeFileSystem } from '../test/fake-file-system';
import { fakeFetchResponse } from '../test/fake-fetch';
import {
  createTextEditorStub,
  emitDidChangeChartMetadata,
  emitDidChangeVisibleTextEditors,
  emitDidOpenTextDocument,
  getLastDiagnosticCollection,
  getLastFileSystemWatcher,
  getRegisteredHoverProvider,
  setOpenTextDocuments,
  setVisibleTextEditors,
  setWarningMessageAnswer,
  window,
  type TextEditorStub,
} from '../test/vscode-stub';
import { activate, deactivate } from './extension';

const REPOSITORY = 'docker.io/library/nginx';
const TAG = '1.19';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: ${TAG}`, ''].join('\n');
const TAGLESS_VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, '  pullPolicy: IfNotPresent', ''].join('\n');

// No chart metadata anywhere, so the fixtures named `values.yaml` resolve
// through the filename fallback and the older tests keep describing exactly
// what they did before chart context existed.
const NO_FILES = createFakeFileSystem({});

/** Stages `document` as the only visible editor, then fires the open event. */
async function openInVisibleEditor(document: vscode.TextDocument): Promise<TextEditorStub> {
  const editor = createTextEditorStub(document);

  setVisibleTextEditors([editor]);
  await emitDidOpenTextDocument(document);

  return editor;
}

/** The decoration options an editor's most recent `setDecorations` call carried. */
function getLastDecorations(editor: TextEditorStub): vscode.DecorationOptions[] {
  const { calls } = editor.setDecorations.mock;
  const lastCall = calls[calls.length - 1] as [unknown, vscode.DecorationOptions[]] | undefined;

  if (lastCall === undefined) {
    throw new Error('expected setDecorations to have been called');
  }

  return lastCall[1];
}

/** Asks the registered hover provider for a hover at `offset` in `document`. */
function hoverAt(document: vscode.TextDocument, offset: number): vscode.Hover | undefined {
  return getRegisteredHoverProvider()?.provideHover(document, document.positionAt(offset)) as vscode.Hover | undefined;
}

/** Asserts a diagnostics `.set()` call carried exactly one diagnostic, and returns it. */
function getSingleDiagnostic(fileDiagnostics: readonly vscode.Diagnostic[] | undefined): vscode.Diagnostic {
  expect(fileDiagnostics).toHaveLength(1);

  const [diagnostic] = fileDiagnostics ?? [];

  if (diagnostic === undefined) {
    throw new Error('expected exactly one diagnostic');
  }

  return diagnostic;
}

describe('extension', () => {
  // Every test calls activate() against the shared vscode stub, which
  // registers a listener on a module-level event emitter. Disposing the
  // context's subscriptions between tests — exactly what the real extension
  // host does on deactivation — unregisters that listener so one test's
  // fetch stub never fires for another test's document.
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    context = createFakeContext();
  });

  afterEach(() => {
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    setVisibleTextEditors([]);
    setOpenTextDocuments([]);
    setWarningMessageAnswer(undefined);
    window.showWarningMessage.mockClear();
  });

  it('should create an output channel and register it for disposal on activate', () => {
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Infra Tools');
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(1);
  });

  it('should not throw on deactivate', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('should register a yaml hover provider on activate', () => {
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    expect(vscode.languages.registerHoverProvider).toHaveBeenCalledWith({ language: 'yaml' }, expect.anything());
  });

  it('should create one mark decoration type on activate', () => {
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledWith({ after: { margin: '0 0 0 0.5em' } });
  });

  it('should set both diagnostics and marks when a values file opens', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const editor = await openInVisibleEditor(document);
    const diagnostic = getSingleDiagnostic(getLastDiagnosticCollection()?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined);

    expect(diagnostic.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(diagnostic.message).toContain(TAG);
    expect(getLastDecorations(editor)[0]?.renderOptions?.after?.contentText).toBe(' ✗');
  });

  it('should hover a checked reference, and stop once the document has been edited past the check', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    expect(hoverAt(document, VALUES_YAML.indexOf(REPOSITORY))).toBeDefined();

    bumpVersion(document);

    expect(hoverAt(document, VALUES_YAML.indexOf(REPOSITORY))).toBeUndefined();
  });

  it('should re-apply marks to an editor that becomes visible after the document was checked', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    setVisibleTextEditors([]);
    await emitDidOpenTextDocument(document);

    const editor = createTextEditorStub(document);
    await emitDidChangeVisibleTextEditors([editor]);

    expect(getLastDecorations(editor)[0]?.renderOptions?.after?.contentText).toBe(' ✓');
  });

  it('should survive an editor disposed mid-check, since an unhandled rejection kills the extension host', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const disposedEditor: TextEditorStub = {
      document,
      setDecorations: vi.fn(() => {
        throw new Error('TextEditor#setDecorations: editor disposed');
      }),
    };

    setVisibleTextEditors([disposedEditor]);

    await expect(emitDidOpenTextDocument(document)).resolves.toBeUndefined();
    expect(getLastDiagnosticCollection()?.set).toHaveBeenCalledWith(document.uri, []);
  });

  it('should create a status bar item on activate', () => {
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
  });

  it('should notify, and raise no diagnostic, for a registry with no local credential', async () => {
    const fetch = vi.fn();
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument(
      '/repo/chart/values.yaml',
      ['image:', '  repository: private.example.com/svc', '  tag: 1.0.0', ''].join('\n')
    );
    await openInVisibleEditor(document);

    // `void`-ed in the listener, so the notification is raised during the
    // check but its promise is not what the listener awaits.
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('private.example.com'), expect.any(String), expect.any(String));

    // A missing credential is a fact about this machine, not a defect in the
    // file. Putting it in the Problems panel beside real errors is how a
    // panel earns being ignored.
    expect(getLastDiagnosticCollection()?.set).toHaveBeenCalledWith(document.uri, []);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should notify once per registry across files, not once per file', async () => {
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    const values = ['image:', '  repository: private.example.com/svc', '  tag: 1.0.0', ''].join('\n');

    await emitDidOpenTextDocument(createFakeDocument('/repo/chart-a/values.yaml', values));
    await emitDidOpenTextDocument(createFakeDocument('/repo/chart-b/values.yaml', values));

    expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('should issue no request for a document that is not a values file', async () => {
    const fetch = vi.fn();
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    await emitDidOpenTextDocument(createFakeDocument('/repo/chart/deployment.yaml', VALUES_YAML));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('should watch chart metadata under both spellings on activate', () => {
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    expect(getLastFileSystemWatcher()?.globPattern).toBe('**/Chart.{yaml,yml}');
  });

  it('should re-check the documents a chart governs when its metadata changes, and leave the others alone', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, {
      fetch,
      credentials: noDockerCredentials,
      readTextFile: createFakeFileSystem({
        '/repo/chart/Chart.yaml': ['apiVersion: v2', 'name: my-service', `appVersion: ${TAG}`, ''].join('\n'),
        '/repo/other/Chart.yaml': ['apiVersion: v2', 'name: other', 'appVersion: 2.0.0', ''].join('\n'),
      }),
    });

    const governed = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);
    const unrelated = createFakeDocument(
      '/repo/other/values.yaml',
      ['image:', '  repository: docker.io/library/redis', '  pullPolicy: Always', ''].join('\n')
    );

    await emitDidOpenTextDocument(governed);
    await emitDidOpenTextDocument(unrelated);
    setOpenTextDocuments([governed, unrelated]);
    fetch.mockClear();

    await emitDidChangeChartMetadata({ path: '/repo/chart/Chart.yaml' });

    // A bumped `appVersion` is exactly when a stale checkmark costs the most,
    // and the chart nobody touched has nothing new to be asked about.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`https://registry-1.docker.io/v2/library/nginx/manifests/${TAG}`, expect.anything());
  });
});
