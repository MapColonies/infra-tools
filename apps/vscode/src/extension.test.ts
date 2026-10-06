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
  emitDidChangeConfiguration,
  emitDidChangeVisibleTextEditors,
  emitDidOpenTextDocument,
  getLastDiagnosticCollection,
  getLastFileSystemWatcher,
  getRegisteredHoverProvider,
  getStatusBarItems,
  setConfiguration,
  setOpenTextDocuments,
  setVisibleTextEditors,
  setWarningMessageAnswer,
  window,
  type StatusBarItemStub,
  type TextEditorStub,
} from '../test/vscode-stub';
import { activate, deactivate } from './extension';
import { LATEST_TAG_WARNING_SETTING } from './latest-tag-setting';
import { REGISTRY_OVERRIDES_SETTING } from './registry-overrides';

const REPOSITORY = 'docker.io/library/nginx';
const TAG = '1.19';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: ${TAG}`, ''].join('\n');
const LATEST_VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, '  tag: latest', ''].join('\n');
const TAGLESS_VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, '  pullPolicy: IfNotPresent', ''].join('\n');

// No chart metadata anywhere, so the fixtures named `values.yaml` resolve
// through the filename fallback and the older tests keep describing exactly
// what they did before chart context existed.
const NO_FILES = createFakeFileSystem({});

/** Chart metadata declaring `appVersion`, for tests about what a bump re-checks. */
function chartMetadataWithAppVersion(appVersion: string): string {
  return ['apiVersion: v2', 'name: my-service', `appVersion: ${appVersion}`, ''].join('\n');
}

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

/** The most recent status bar item that has ever announced overrides, found by the icon it shows them with. */
function getOverrideStatusBarItem(): StatusBarItemStub | undefined {
  return getStatusBarItems()
    .filter((item) => item.text.startsWith('$(arrow-swap)'))
    .at(-1);
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
    setConfiguration({});
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

  it('should check only the declared override registries, and name the matching one on the checkmark', async () => {
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: ['quay.io'] });
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const editor = await openInVisibleEditor(createFakeDocument('/repo/chart/values.yaml', VALUES_YAML));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://quay.io/v2/library/nginx/manifests/1.19', expect.anything());
    expect(getLastDecorations(editor)[0]?.renderOptions?.after?.contentText).toBe(' ✓ quay.io');
  });

  it('should name the override in the diagnostic when no override registry has the tag', async () => {
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: ['quay.io'] });
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    await openInVisibleEditor(createFakeDocument('/repo/chart/values.yaml', VALUES_YAML));
    const diagnostic = getSingleDiagnostic(getLastDiagnosticCollection()?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined);

    expect(diagnostic.message).toContain('Registry override in effect: checked only quay.io.');
  });

  it('should show the override status bar item on activate while overrides are declared', () => {
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: ['ghcr.io', 'quay.io'] });
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    expect(getOverrideStatusBarItem()?.visible).toBe(true);
    expect(getOverrideStatusBarItem()?.text).toBe('$(arrow-swap) 2');
  });

  it('should re-check open documents and refresh the status bar when the override setting changes', async () => {
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: ['quay.io'] });
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    setOpenTextDocuments([document]);
    const editor = await openInVisibleEditor(document);
    fetch.mockClear();

    await emitDidChangeConfiguration({ [REGISTRY_OVERRIDES_SETTING]: [] });

    // Back to the file's own registry: a checkmark earned on the override
    // must not outlive the override.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://registry-1.docker.io/v2/library/nginx/manifests/1.19', expect.anything());
    expect(getLastDecorations(editor)[0]?.renderOptions?.after?.contentText).toBe(' ✓');
    expect(getOverrideStatusBarItem()?.visible).toBe(false);
  });

  it('should ignore a settings change that does not touch the override set', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    setOpenTextDocuments([document]);
    await emitDidOpenTextDocument(document);
    fetch.mockClear();

    await emitDidChangeConfiguration({ 'editor.fontSize': 14 });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('should warn on a latest tag by default, and still check it exists', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    await openInVisibleEditor(createFakeDocument('/repo/chart/values.yaml', LATEST_VALUES_YAML));
    const fileDiagnostics = getLastDiagnosticCollection()?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined;

    expect(fetch).toHaveBeenCalledWith('https://registry-1.docker.io/v2/library/nginx/manifests/latest', expect.anything());
    expect(fileDiagnostics?.map(({ severity }) => severity)).toEqual(
      expect.arrayContaining([vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning])
    );
    expect(fileDiagnostics).toHaveLength(2);
  });

  it('should warn on a quoted latest tag, underlining the tag inside the quotes', async () => {
    const yaml = ['image:', `  repository: ${REPOSITORY}`, '  tag: "latest"', ''].join('\n');
    const document = createFakeDocument('/repo/chart/values.yaml', yaml);
    activate(context, { fetch: vi.fn().mockResolvedValue(fakeFetchResponse(200)), credentials: noDockerCredentials, readTextFile: NO_FILES });

    await openInVisibleEditor(document);
    const diagnostic = getSingleDiagnostic(getLastDiagnosticCollection()?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined);
    const start = yaml.indexOf('latest');

    expect(diagnostic.severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(diagnostic.range).toEqual(new vscode.Range(document.positionAt(start), document.positionAt(start + 'latest'.length)));
  });

  it('should not warn on latest pinned to a digest, since what deploys can no longer drift', async () => {
    const yaml = ['image:', `  repository: ${REPOSITORY}`, `  tag: latest@sha256:${'a'.repeat(64)}`, ''].join('\n');
    activate(context, { fetch: vi.fn().mockResolvedValue(fakeFetchResponse(200)), credentials: noDockerCredentials, readTextFile: NO_FILES });

    await openInVisibleEditor(createFakeDocument('/repo/chart/values.yaml', yaml));
    const fileDiagnostics = getLastDiagnosticCollection()?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined;

    expect(fileDiagnostics?.filter(({ severity }) => severity === vscode.DiagnosticSeverity.Warning)).toEqual([]);
  });

  it('should not warn on a latest tag while the setting is off, and still check it exists', async () => {
    setConfiguration({ [LATEST_TAG_WARNING_SETTING]: false });
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    await openInVisibleEditor(createFakeDocument('/repo/chart/values.yaml', LATEST_VALUES_YAML));
    const diagnostic = getSingleDiagnostic(getLastDiagnosticCollection()?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(diagnostic.severity).toBe(vscode.DiagnosticSeverity.Error);
  });

  it('should republish diagnostics without asking a registry again when the latest warning setting changes', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    const document = createFakeDocument('/repo/chart/values.yaml', LATEST_VALUES_YAML);
    setOpenTextDocuments([document]);
    await openInVisibleEditor(document);
    fetch.mockClear();

    await emitDidChangeConfiguration({ [LATEST_TAG_WARNING_SETTING]: false });

    // A style rule changed, not a registry answer, so nothing is re-asked.
    expect(fetch).not.toHaveBeenCalled();
    expect(getLastDiagnosticCollection()?.set.mock.calls.at(-1)?.[1]).toEqual([]);

    await emitDidChangeConfiguration({ [LATEST_TAG_WARNING_SETTING]: true });

    expect(getSingleDiagnostic(getLastDiagnosticCollection()?.set.mock.calls.at(-1)?.[1] as vscode.Diagnostic[] | undefined).severity).toBe(
      vscode.DiagnosticSeverity.Warning
    );
  });

  it('should issue no request for a document that is not a values file', async () => {
    const fetch = vi.fn();
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES });

    await emitDidOpenTextDocument(createFakeDocument('/repo/chart/deployment.yaml', VALUES_YAML));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('should watch the chart metadata name chart resolution actually reads', () => {
    activate(context, { fetch: vi.fn(), credentials: noDockerCredentials, readTextFile: NO_FILES });

    expect(getLastFileSystemWatcher()?.globPattern).toBe('**/Chart.yaml');
  });

  it('should re-check the documents a chart governs against its new appVersion, and leave the others alone', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const files: Record<string, string> = {
      '/repo/chart/Chart.yaml': chartMetadataWithAppVersion('1.18'),
      '/repo/other/Chart.yaml': ['apiVersion: v2', 'name: other', 'appVersion: 2.0.0', ''].join('\n'),
    };
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: createFakeFileSystem(files) });

    const governed = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);
    const unrelated = createFakeDocument(
      '/repo/other/values.yaml',
      ['image:', '  repository: docker.io/library/redis', '  pullPolicy: Always', ''].join('\n')
    );

    await emitDidOpenTextDocument(governed);
    await emitDidOpenTextDocument(unrelated);
    setOpenTextDocuments([governed, unrelated]);
    fetch.mockClear();

    files['/repo/chart/Chart.yaml'] = chartMetadataWithAppVersion(TAG);
    await emitDidChangeChartMetadata({ path: '/repo/chart/Chart.yaml' });

    // A bumped `appVersion` is exactly when a stale checkmark costs the most,
    // and the chart nobody touched has nothing new to be asked about.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`https://registry-1.docker.io/v2/library/nginx/manifests/${TAG}`, expect.anything());
  });

  it('should keep the latest re-check when an earlier one for the same document answers after it', async () => {
    type FakeResponse = ReturnType<typeof fakeFetchResponse>;
    let answerSlowRequest: (response: FakeResponse) => void = () => undefined;
    const slowAnswer = new Promise<FakeResponse>((resolve) => {
      answerSlowRequest = resolve;
    });
    const fetch = vi.fn(async (url: string) => (url.endsWith('/manifests/1.18') ? slowAnswer : Promise.resolve(fakeFetchResponse(200))));
    const files: Record<string, string> = { '/repo/chart/Chart.yaml': chartMetadataWithAppVersion('1.17') };
    activate(context, { fetch, credentials: noDockerCredentials, readTextFile: createFakeFileSystem(files) });

    const document = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);
    await emitDidOpenTextDocument(document);
    setOpenTextDocuments([document]);

    // Two saves in quick succession, as autosave produces while typing a
    // version: the first one's registry answer is still in flight when the
    // second one lands.
    files['/repo/chart/Chart.yaml'] = chartMetadataWithAppVersion('1.18');
    const firstRecheck = emitDidChangeChartMetadata({ path: '/repo/chart/Chart.yaml' });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/manifests\/1\.18$/), expect.anything());
    });

    files['/repo/chart/Chart.yaml'] = chartMetadataWithAppVersion(TAG);
    await emitDidChangeChartMetadata({ path: '/repo/chart/Chart.yaml' });

    answerSlowRequest(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    await firstRecheck;

    const setCalls = getLastDiagnosticCollection()?.set.mock.calls ?? [];

    expect(setCalls[setCalls.length - 1]?.[1]).toEqual([]);
  });
});
