import path from 'node:path';
import { readPackageJsonSync } from '@map-colonies/read-pkg';
import { Command } from 'commander';

interface PackageMetadata {
  name: string;
  version: string;
  description?: string;
}

/**
 * Reads this workspace's own package.json so the CLI's reported version and
 * description always match what actually shipped, instead of a value
 * duplicated (and liable to drift) in source.
 */
function readPackageMetadata(): PackageMetadata {
  const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json');

  return readPackageJsonSync(packageJsonPath) as PackageMetadata;
}

/**
 * Builds the `mct` program. Kept separate from the executable entry point
 * (`index.ts`) so subcommands can be registered here via `program.command()`
 * as they're added, without touching how the binary is invoked, and so tests
 * can build a `Command` without spawning a process.
 */
export function createProgram(): Command {
  const { version, description } = readPackageMetadata();

  const program = new Command();

  program
    .name('mct')
    .description(description ?? 'MapColonies infra-tools CLI')
    .version(version, '-v, --version', 'output the current version');

  // Subcommands are added here via program.command(...) as they're built.

  return program;
}
