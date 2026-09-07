// Bundles the extension into a single CommonJS file for the VS Code
// extension host, leaving the `vscode` module external (it's supplied by
// the host at runtime). Follows the bundling approach from VS Code's
// official extension guidance: https://code.visualstudio.com/api/working-with-extensions/bundling-extension
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    sourcemap: !production,
    sourcesContent: false,
    minify: production,
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
  } else {
    // dispose() in a finally: a build error must not leave the esbuild
    // service process running, or the task hangs instead of exiting.
    try {
      await ctx.rebuild();
    } finally {
      await ctx.dispose();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
