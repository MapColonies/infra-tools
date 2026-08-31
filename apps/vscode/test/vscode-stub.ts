import { vi } from 'vitest';

/**
 * Minimal stand-in for the `vscode` module.
 *
 * Resolved in place of the real `vscode` package via the `resolve.alias`
 * entry in vitest.config.ts, so extension code can do
 * `import * as vscode from 'vscode'` in tests without booting a real VS Code
 * instance. Extend this stub as the extension grows — don't add per-file
 * `vi.mock('vscode', …)` factories.
 */
export const window = {
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    dispose: vi.fn(),
  })),
};
