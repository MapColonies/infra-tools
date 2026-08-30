// Scopes are required on every commit and validated against the actual workspace names,
// discovered dynamically from pnpm-workspace.yaml so the allow-list can never drift from the
// real workspaces. The release-please and dependency-bump commits get two extra scopes that
// name no workspace.
const EXTRA_SCOPES = ['release', 'deps'];

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@map-colonies/commitlint-config'],
  rules: {
    'scope-empty': [2, 'never'],
    'scope-enum': async (ctx) => {
      const { default: pnpmScopes } = await import('@commitlint/config-pnpm-scopes');
      const [level, condition, workspaceScopes] = await pnpmScopes.rules['scope-enum'](ctx);
      return [level, condition, [...workspaceScopes.filter((scope) => scope !== 'global'), ...EXTRA_SCOPES]];
    },
  },
};
