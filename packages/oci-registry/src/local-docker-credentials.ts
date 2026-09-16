import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CredentialEnvironment } from './credentials';

// The helper name arrives out of `config.json`, which is a file any process
// on the machine can write. It is interpolated into a command name, so this
// is the boundary that has to refuse anything outside the character set
// real helper names use, rather than trusting the file or relying on
// `spawn` without a shell to make an arbitrary string harmless.
const HELPER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

const SUCCESS_EXIT_CODE = 0;

/**
 * Locates `config.json`.
 *
 * `DOCKER_CONFIG` takes precedence because that is how the Docker CLI itself
 * resolves the file, and a developer who sets it — CI images and
 * multi-account setups do — has moved the credentials this package is
 * looking for. An empty value counts as unset, since exporting an empty
 * variable is how a shell says "no override", not "look in `/config.json`".
 */
function dockerConfigPath(): string {
  const override = process.env['DOCKER_CONFIG'];

  if (override === undefined || override === '') {
    return join(homedir(), '.docker', 'config.json');
  }

  return join(override, 'config.json');
}

/**
 * Reads `config.json`, reporting every failure as "there is no config".
 *
 * A machine that has never run `docker login` has no such file, which is an
 * ordinary state rather than an error, and the same is true of one whose
 * home directory is unreadable to this process. Both mean the same thing to
 * the caller — no credential is available here — so neither is worth
 * distinguishing into an exception the check would have to survive.
 */
async function readDockerConfig(): Promise<string | undefined> {
  try {
    return await readFile(dockerConfigPath(), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Runs a credential helper and returns its stdout.
 *
 * The helper protocol is a subprocess: the server URL goes in on stdin, the
 * JSON credential comes back on stdout, and "I don't have this one" is a
 * non-zero exit. That last case is why this rejects rather than resolving
 * empty — the caller treats a rejection as a miss and falls through to the
 * next credential source, and collapsing a miss into an empty string would
 * make it indistinguishable from a helper that answered with nothing.
 */
async function runCredentialHelper(helper: string, serverUrl: string): Promise<string> {
  if (!HELPER_NAME_PATTERN.test(helper)) {
    throw new Error(`refusing to run a credential helper whose name is not a plain identifier: ${helper}`);
  }

  const command = `docker-credential-${helper}`;

  return new Promise<string>((resolve, reject) => {
    // stderr is discarded: helpers write their "credentials not found"
    // prose there, and that is the routine miss, not a diagnostic anyone
    // needs.
    const child = spawn(command, ['get'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const { stdin, stdout: output } = child;

    let collected = '';

    output.setEncoding('utf8');
    output.on('data', (chunk: string) => {
      collected += chunk;
    });

    child.on('error', reject);

    // A helper that rejects the request by exiting before it ever reads
    // stdin leaves the write below failing with EPIPE, and an unhandled
    // `error` on a stream is thrown rather than returned — inside the
    // extension host that takes down the process over what is, to this
    // package, an ordinary miss. Routed to `reject` so it stays one.
    stdin.on('error', reject);

    child.on('close', (code) => {
      if (code === SUCCESS_EXIT_CODE) {
        resolve(collected);
        return;
      }

      reject(new Error(`${command} exited with code ${String(code)}`));
    });

    stdin.end(`${serverUrl}\n`);
  });
}

/**
 * The production credential environment: the real `config.json` and the
 * real helper subprocesses.
 *
 * It exists as a value rather than as the default behaviour of the
 * resolution code so that the disk and the process table stay on one side
 * of a seam. A test names the config contents and the helper output it
 * wants; nothing else in this package can reach the filesystem at all.
 */
const localDockerCredentials: CredentialEnvironment = { readDockerConfig, runCredentialHelper };

export { localDockerCredentials };
