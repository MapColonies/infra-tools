/**
 * Minimal stand-in for the `vscode` module.
 *
 * Resolved in place of the real `vscode` package via the `resolve.alias`
 * entry in vitest.config.ts, so extension code can do
 * `import * as vscode from 'vscode'` in tests without booting a real VS Code
 * instance. Extend this stub as the extension grows — don't add per-file
 * `vi.mock('vscode', …)` factories.
 *
 * @packageDocumentation
 */

import { vi } from 'vitest';

class Position {
  public constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

class Range {
  public constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
}

class ThemeColor {
  public constructor(public readonly id: string) {}
}

class MarkdownString {
  public constructor(public readonly value: string = '') {}
}

class Hover {
  public readonly contents: (MarkdownString | string)[];

  public constructor(
    contents: MarkdownString | string | (MarkdownString | string)[],
    public readonly range?: Range
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

// This reproduces the real `vscode.DiagnosticSeverity` enum's member names
// and values exactly — extension code does `vscode.DiagnosticSeverity.Error`
// against the real `@types/vscode` declaration, so the stub's runtime shape
// has to match it verbatim, PascalCase members and all.
/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-magic-numbers --
   mirrors vscode.DiagnosticSeverity's real member names and fixed values */
enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-magic-numbers */

class Diagnostic {
  public constructor(
    public readonly range: Range,
    public readonly message: string,
    public readonly severity?: DiagnosticSeverity
  ) {}
}

interface DiagnosticCollectionStub {
  readonly set: ReturnType<typeof vi.fn>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

// Every collection `languages.createDiagnosticCollection` has ever handed
// out, so a test can look up the one its own `activate()` call created
// without fighting `vi.mocked`'s type inference over an overloaded real
// `vscode` signature.
const diagnosticCollections: DiagnosticCollectionStub[] = [];

function createDiagnosticCollectionStub(): DiagnosticCollectionStub {
  const diagnosticsByUri = new Map<unknown, readonly Diagnostic[]>();
  const stub: DiagnosticCollectionStub = {
    set: vi.fn((uri: unknown, fileDiagnostics: readonly Diagnostic[]) => {
      diagnosticsByUri.set(uri, fileDiagnostics);
    }),
    get: vi.fn((uri: unknown) => diagnosticsByUri.get(uri) ?? []),
    dispose: vi.fn(),
  };

  diagnosticCollections.push(stub);

  return stub;
}

/** The subset of `vscode.HoverProvider` the extension registers. */
interface HoverProviderStub {
  readonly provideHover: (document: unknown, position: unknown) => unknown;
}

// Registered providers are removed again on dispose, so a test that disposes
// its context's subscriptions leaves no provider behind for the next one.
let hoverProviders: HoverProviderStub[] = [];

const languages = {
  createDiagnosticCollection: vi.fn(() => createDiagnosticCollectionStub()),
  registerHoverProvider: vi.fn((_selector: unknown, provider: HoverProviderStub) => {
    hoverProviders.push(provider);

    return {
      dispose: vi.fn(() => {
        hoverProviders = hoverProviders.filter((registered) => registered !== provider);
      }),
    };
  }),
};

/** Test-only helper: the most recently created diagnostic collection. */
function getLastDiagnosticCollection(): DiagnosticCollectionStub | undefined {
  return diagnosticCollections[diagnosticCollections.length - 1];
}

/** Test-only helper: the most recently registered, still-undisposed hover provider. */
function getRegisteredHoverProvider(): HoverProviderStub | undefined {
  return hoverProviders[hoverProviders.length - 1];
}

/**
 * Test-only stand-in for `vscode.TextEditor`: the document it shows, and a
 * spy recording every `setDecorations` call made against it.
 */
interface TextEditorStub {
  readonly document: unknown;
  readonly setDecorations: ReturnType<typeof vi.fn>;
}

/** Test-only helper that builds a {@link TextEditorStub}. Not part of the real `vscode` API. */
function createTextEditorStub(document: unknown): TextEditorStub {
  return { document, setDecorations: vi.fn() };
}

/**
 * A minimal `vscode.Event<T>`-shaped emitter: `event` is what extension code
 * subscribes through, `fire` is a test-only helper (not part of the real
 * `vscode` API) that drives registered listeners and awaits anything they
 * return, so a test can `await` a fire and then assert on its effects.
 * `dispose()` actually unregisters the listener, matching real VS Code
 * disposables, so tests that dispose a context's subscriptions between runs
 * don't leak listeners into later tests.
 */
function createEventEmitterStub<T>(): {
  event: (listener: (value: T) => unknown) => { dispose: () => void };
  fire: (value: T) => Promise<void>;
} {
  let listeners: ((value: T) => unknown)[] = [];

  return {
    event: (listener: (value: T) => unknown): { dispose: () => void } => {
      listeners.push(listener);

      return {
        dispose: vi.fn(() => {
          listeners = listeners.filter((registered) => registered !== listener);
        }),
      };
    },
    fire: async (value: T): Promise<void> => {
      for (const listener of listeners) {
        await listener(value);
      }
    },
  };
}

const onDidOpenTextDocumentEmitter = createEventEmitterStub<unknown>();
const onDidChangeVisibleTextEditorsEmitter = createEventEmitterStub<readonly TextEditorStub[]>();

const window = {
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    dispose: vi.fn(),
  })),
  createTextEditorDecorationType: vi.fn(() => ({ key: 'decoration-type', dispose: vi.fn() })),
  visibleTextEditors: [] as readonly TextEditorStub[],
  onDidChangeVisibleTextEditors: onDidChangeVisibleTextEditorsEmitter.event,
};

const workspace = {
  onDidOpenTextDocument: onDidOpenTextDocumentEmitter.event,
};

/**
 * Test-only helper that fires `workspace.onDidOpenTextDocument` and awaits
 * every registered listener. Not part of the real `vscode` API — extension
 * code never calls this, only tests do, to simulate a document opening.
 */
async function emitDidOpenTextDocument(document: unknown): Promise<void> {
  await onDidOpenTextDocumentEmitter.fire(document);
}

/**
 * Test-only helper that replaces `window.visibleTextEditors`. Not part of the
 * real `vscode` API — tests set it to stage which editors the extension can
 * decorate, and reset it so one test's editors never leak into another.
 */
function setVisibleTextEditors(editors: readonly TextEditorStub[]): void {
  window.visibleTextEditors = editors;
}

/**
 * Test-only helper that fires `window.onDidChangeVisibleTextEditors` after
 * updating `window.visibleTextEditors`, the order real VS Code uses.
 */
async function emitDidChangeVisibleTextEditors(editors: readonly TextEditorStub[]): Promise<void> {
  setVisibleTextEditors(editors);
  await onDidChangeVisibleTextEditorsEmitter.fire(editors);
}

export type { TextEditorStub };
export {
  createTextEditorStub,
  Diagnostic,
  DiagnosticSeverity,
  emitDidChangeVisibleTextEditors,
  emitDidOpenTextDocument,
  getLastDiagnosticCollection,
  getRegisteredHoverProvider,
  Hover,
  languages,
  MarkdownString,
  Position,
  Range,
  setVisibleTextEditors,
  ThemeColor,
  window,
  workspace,
};
