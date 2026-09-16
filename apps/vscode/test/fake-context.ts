import type * as vscode from 'vscode';

/**
 * Builds a fake `vscode.ExtensionContext` with a working in-memory
 * `globalState`.
 *
 * The state is real rather than a spy, because what the tests need to assert
 * is that a value written in one activation is read back by the next — which
 * is what "a dismissed registry never notifies again across window reloads"
 * means. Seeding `stored` is how a test stages a previous session.
 */
function createFakeContext(stored: Readonly<Record<string, unknown>> = {}): vscode.ExtensionContext {
  const values = new Map<string, unknown>(Object.entries(stored));

  return {
    subscriptions: [],
    globalState: {
      get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
      // eslint-disable-next-line @typescript-eslint/promise-function-async -- an in-memory write, nothing to await
      update: (key: string, value: unknown) => {
        values.set(key, value);

        return Promise.resolve();
      },
      keys: () => [...values.keys()],
    },
  } as unknown as vscode.ExtensionContext;
}

export { createFakeContext };
