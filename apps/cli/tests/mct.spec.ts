import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// This exercises the built binary end to end: it spawns `bin/mct.js` (the
// package's own `bin` entry, which imports the compiled `dist/index.js`) as
// a real child process, the same way a shell invoking `mct` would. That's
// deliberate — it's the only way to prove both the binary wiring (bin field,
// shebang, executable bit) and the ESM build output actually work, as
// opposed to just the TypeScript source under ts-node/tsx.
const execFileAsync = promisify(execFile);

const binPath = path.join(import.meta.dirname, '..', 'bin', 'mct.js');
const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json');

interface PackageMetadata {
  version: string;
}

function readOwnVersion(): string {
  const raw = readFileSync(packageJsonPath, 'utf8');
  const { version } = JSON.parse(raw) as PackageMetadata;

  return version;
}

describe('mct binary', () => {
  it('prints usage for --help', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '--help']);

    expect(stdout).toContain('Usage: mct');
  });

  it('prints the workspace version for --version', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath, '--version']);

    expect(stdout.trim()).toBe(readOwnVersion());
  });
});
