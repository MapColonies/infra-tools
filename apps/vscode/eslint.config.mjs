// @ts-check
import tsBaseConfig from '@map-colonies/eslint-config/ts-base';
import vitestConfig from '@map-colonies/eslint-config/vitest';
import { config } from '@map-colonies/eslint-config/helpers';

export default config(tsBaseConfig, vitestConfig, {
  name: 'vscode/settings',
  settings: {
    // The `vscode` module is provided by the extension host at runtime, not
    // an installable npm package — treat it like a Node builtin so import
    // resolution/extraneous-dependency rules don't flag it.
    'import-x/core-modules': ['vscode'],
  },
});
