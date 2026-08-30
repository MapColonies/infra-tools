import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Real logic (never importing `vscode`) belongs in packages/*, where it
      // needs no mocking at all. This workspace's own code touches the
      // `vscode` API directly, so tests resolve it to one checked-in stub
      // instead of per-file `vi.mock('vscode', …)` factories.
      vscode: fileURLToPath(new URL('./test/vscode-stub.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
