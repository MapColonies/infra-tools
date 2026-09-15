import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTextEditorStub,
  emitDidChangeVisibleTextEditors,
  emitDidOpenTextDocument,
  getLastDiagnosticCollection,
  getRegisteredHoverProvider,
  setVisibleTextEditors,
  type TextEditorStub,
} from '../test/vscode-stub';
import { activate, deactivate } from './extension';

/** Builds a fake `vscode.TextDocument`, with a real `positionAt`/`offsetAt` pair so range assertions are exact. */
function createFakeDocument(path: string, text: string, languageId = 'yaml'): vscode.TextDocument {
  return {
    uri: { path, toString: () => path },
    languageId,
    version: 1,
    getText: () => text,
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const lines = before.split('\n');
      const line = lines.length - 1;
      const character = lines[lines.length - 1]?.length ?? 0;

      return new vscode.Position(line, character);
    },
    offsetAt: (position: vscode.Position) => {
      const lines = text.split('\n');
      let offset = 0;

      for (let line = 0; line < position.line; line += 1) {
        offset += (lines[line]?.length ?? 0) + '\n'.length;
      }

      return offset + position.character;
    },
  } as unknown as vscode.TextDocument;
}

const VALUES_YAML = ['image:', '  repository: docker.io/library/nginx', '  tag: 1.19', ''].join('\n');

/** Three references whose outcomes differ, so one file exercises all three marks at once. */
const MIXED_VALUES_YAML = [
  'good:',
  '  image:',
  '    repository: registry.example.com/good',
  '    tag: "1.0"',
  'bad:',
  '  image:',
  '    repository: registry.example.com/bad',
  '    tag: "2.0"',
  'unknown:',
  '  image:',
  '    repository: registry.example.com/unknown',
  '    tag: "3.0"',
  '',
].join('\n');

/** A canned fetch `Response`-shaped object for the injected fetch fake. */
function fakeFetchResponse(status: number, body: unknown = {}): { status: number; ok: boolean; json: () => Promise<unknown> } {
  return {
    status,
    ok: status >= 200 && status < 300,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- trivial canned response, nothing to await
    json: () => Promise.resolve(body),
  };
}

/** Simulates an edit: VS Code bumps a document's `version` on every change. */
function bumpVersion(document: vscode.TextDocument): void {
  (document as { version: number }).version += 1;
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

/** The plain text of a hover's single content entry. */
function getHoverText(hover: vscode.Hover | undefined): string {
  const [content] = hover?.contents ?? [];

  if (content === undefined || typeof content === 'string') {
    throw new Error('expected a hover carrying one MarkdownString');
  }

  return content.value;
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
    context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  });

  afterEach(() => {
    for (const subscription of context.subscriptions) {
      subscription.dispose();
    }

    setVisibleTextEditors([]);
  });

  it('should create an output channel and register it for disposal on activate', () => {
    activate(context, { fetch: vi.fn() });

    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Infra Tools');
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(1);
  });

  it('should not throw on deactivate', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('should set no diagnostics when the referenced image exists', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await emitDidOpenTextDocument(document);

    const collection = getLastDiagnosticCollection();

    expect(collection?.set).toHaveBeenCalledWith(document.uri, []);
  });

  it('should set an error diagnostic naming the missing tag, positioned on the tag value, when the tag does not exist', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await emitDidOpenTextDocument(document);

    const collection = getLastDiagnosticCollection();
    const diagnostic = getSingleDiagnostic(collection?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined);

    expect(diagnostic.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(diagnostic.message).toContain('1.19');

    const tagStart = VALUES_YAML.indexOf('1.19');

    expect(diagnostic.range).toEqual(new vscode.Range(document.positionAt(tagStart), document.positionAt(tagStart + '1.19'.length)));
  });

  it('should set an error diagnostic naming the missing repository when the repository does not exist', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'NAME_UNKNOWN' }] }));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await emitDidOpenTextDocument(document);

    const collection = getLastDiagnosticCollection();
    const diagnostic = getSingleDiagnostic(collection?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined);

    expect(diagnostic.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(diagnostic.message).toContain('docker.io/library/nginx');

    const repositoryStart = VALUES_YAML.indexOf('docker.io/library/nginx');

    expect(diagnostic.range).toEqual(
      new vscode.Range(document.positionAt(repositoryStart), document.positionAt(repositoryStart + 'docker.io/library/nginx'.length))
    );
  });

  it('should set no diagnostics when the registry is unreachable, since unverifiable never renders as an error', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await emitDidOpenTextDocument(document);

    const collection = getLastDiagnosticCollection();

    expect(collection?.set).toHaveBeenCalledWith(document.uri, []);
  });

  it('should render a checkmark on the repository of a reference that exists', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const editor = await openInVisibleEditor(document);
    const decorations = getLastDecorations(editor);

    expect(decorations).toHaveLength(1);
    expect(decorations[0]?.renderOptions?.after?.contentText).toContain('✓');

    const repositoryStart = VALUES_YAML.indexOf('docker.io/library/nginx');

    expect(decorations[0]?.range).toEqual(
      new vscode.Range(document.positionAt(repositoryStart), document.positionAt(repositoryStart + 'docker.io/library/nginx'.length))
    );
  });

  it('should omit the registry name from the checkmark when it matches the host the file names', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const editor = await openInVisibleEditor(document);

    expect(getLastDecorations(editor)[0]?.renderOptions?.after?.contentText).toBe(' ✓');
  });

  it('should render a cross alongside the diagnostic when the tag does not exist', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const editor = await openInVisibleEditor(document);
    const [mark] = getLastDecorations(editor);

    expect(mark?.renderOptions?.after?.contentText).toBe(' ✗');
    expect(mark?.renderOptions?.after?.color).toEqual(new vscode.ThemeColor('errorForeground'));

    const diagnostic = getSingleDiagnostic(getLastDiagnosticCollection()?.set.mock.calls[0]?.[1] as vscode.Diagnostic[] | undefined);

    expect(diagnostic.message).toContain('1.19');
  });

  it('should render a muted question mark and no diagnostic when the reference is unverifiable', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const editor = await openInVisibleEditor(document);
    const [mark] = getLastDecorations(editor);

    expect(mark?.renderOptions?.after?.contentText).toBe(' ?');
    expect(mark?.renderOptions?.after?.color).toEqual(new vscode.ThemeColor('descriptionForeground'));
    expect(getLastDiagnosticCollection()?.set).toHaveBeenCalledWith(document.uri, []);
  });

  it('should report the registry that answered when hovering a verified reference', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    const hoverText = getHoverText(hoverAt(document, VALUES_YAML.indexOf('docker.io/library/nginx')));

    expect(hoverText).toContain('docker.io');
    expect(hoverText).toContain('Verified');
  });

  it('should report why a reference could not be verified when hovering an unverifiable one', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    const hoverText = getHoverText(hoverAt(document, VALUES_YAML.indexOf('1.19')));

    expect(hoverText).toContain('Not verified');
    expect(hoverText).toContain('could not be reached');
  });

  it('should provide no hover for a reference that does not exist, which already speaks through its diagnostic', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    expect(hoverAt(document, VALUES_YAML.indexOf('1.19'))).toBeUndefined();
  });

  it('should provide no hover outside any checked reference', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    expect(hoverAt(document, VALUES_YAML.indexOf('image:'))).toBeUndefined();
  });

  it('should create one mark decoration type and register a yaml hover provider on activate', () => {
    activate(context, { fetch: vi.fn() });

    expect(vscode.window.createTextEditorDecorationType).toHaveBeenCalledWith({ after: { margin: '0 0 0 0.5em' } });
    expect(vscode.languages.registerHoverProvider).toHaveBeenCalledWith({ language: 'yaml' }, expect.anything());
  });

  it('should re-apply checkmarks to an editor that becomes visible after the document was checked', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    setVisibleTextEditors([]);
    await emitDidOpenTextDocument(document);

    const editor = createTextEditorStub(document);
    await emitDidChangeVisibleTextEditors([editor]);

    expect(getLastDecorations(editor)[0]?.renderOptions?.after?.contentText).toBe(' ✓');
  });

  it('should drop checkmarks rather than re-project them onto text edited since the check', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    bumpVersion(document);

    const editor = createTextEditorStub(document);
    await emitDidChangeVisibleTextEditors([editor]);

    expect(getLastDecorations(editor)).toEqual([]);
  });

  it('should provide no hover once the document has been edited past the checked version', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    bumpVersion(document);

    expect(hoverAt(document, VALUES_YAML.indexOf('docker.io/library/nginx'))).toBeUndefined();
  });

  it('should survive an editor disposed mid-check, since an unhandled rejection kills the extension host', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

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

  it('should still decorate the surviving editors when one of them was disposed', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    await openInVisibleEditor(document);

    const disposedEditor: TextEditorStub = {
      document,
      setDecorations: vi.fn(() => {
        throw new Error('TextEditor#setDecorations: editor disposed');
      }),
    };
    const survivingEditor = createTextEditorStub(document);

    await emitDidChangeVisibleTextEditors([disposedEditor, survivingEditor]);

    expect(getLastDecorations(survivingEditor)[0]?.renderOptions?.after?.contentText).toBe(' ✓');
  });

  it('should mark every reference in one pass, whatever each outcome was', async () => {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- canned per-URL responses, nothing to await
    const fetch = vi.fn((url: string) => {
      if (url.includes('/good/')) {
        return Promise.resolve(fakeFetchResponse(200));
      }

      if (url.includes('/bad/')) {
        return Promise.resolve(fakeFetchResponse(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
      }

      return Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    });
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', MIXED_VALUES_YAML);
    const editor = await openInVisibleEditor(document);
    const marks = getLastDecorations(editor);

    expect(marks.map((mark) => mark.renderOptions?.after?.contentText)).toEqual([' ✓', ' ✗', ' ?']);
    expect(marks.map((mark) => mark.renderOptions?.after?.color)).toEqual([
      new vscode.ThemeColor('charts.green'),
      new vscode.ThemeColor('errorForeground'),
      new vscode.ThemeColor('descriptionForeground'),
    ]);
  });

  it('should ignore a document that is not the conventional values file name', async () => {
    const fetch = vi.fn();
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/deployment.yaml', VALUES_YAML);
    await emitDidOpenTextDocument(document);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('should ignore a document whose language is not yaml', async () => {
    const fetch = vi.fn();
    activate(context, { fetch });

    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML, 'plaintext');
    await emitDidOpenTextDocument(document);

    expect(fetch).not.toHaveBeenCalled();
  });
});
