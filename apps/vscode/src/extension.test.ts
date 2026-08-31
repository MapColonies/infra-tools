import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitDidOpenTextDocument, getLastDiagnosticCollection } from '../test/vscode-stub';
import { activate, deactivate } from './extension';

/** Builds a fake `vscode.TextDocument`, with a real `positionAt` so range assertions are exact. */
function createFakeDocument(path: string, text: string, languageId = 'yaml'): vscode.TextDocument {
  return {
    uri: { path, toString: () => path },
    languageId,
    getText: () => text,
    positionAt: (offset: number) => {
      const before = text.slice(0, offset);
      const lines = before.split('\n');
      const line = lines.length - 1;
      const character = lines[lines.length - 1]?.length ?? 0;

      return new vscode.Position(line, character);
    },
  } as unknown as vscode.TextDocument;
}

const VALUES_YAML = ['image:', '  repository: docker.io/library/nginx', '  tag: 1.19', ''].join('\n');

/** A canned fetch `Response`-shaped object for the injected fetch fake. */
function fakeFetchResponse(status: number, body: unknown = {}): { status: number; ok: boolean; json: () => Promise<unknown> } {
  return {
    status,
    ok: status >= 200 && status < 300,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- trivial canned response, nothing to await
    json: () => Promise.resolve(body),
  };
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
