import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localDockerCredentials } from './local-docker-credentials';

/**
 * The one file in this package that really touches the disk and the process
 * table, so it is the one place a test has to as well. Everything built on
 * top of it is exercised through `checkImageExistence` with this environment
 * replaced by a fake.
 */
describe('localDockerCredentials', () => {
  const originalDockerConfig = process.env['DOCKER_CONFIG'];

  afterEach(() => {
    if (originalDockerConfig === undefined) {
      delete process.env['DOCKER_CONFIG'];
    } else {
      process.env['DOCKER_CONFIG'] = originalDockerConfig;
    }
  });

  it('should read config.json out of DOCKER_CONFIG when that names a directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'infra-tools-docker-'));
    const contents = JSON.stringify({ auths: { 'private.example.com': {} } });

    await writeFile(join(directory, 'config.json'), contents, 'utf8');
    process.env['DOCKER_CONFIG'] = directory;

    await expect(localDockerCredentials.readDockerConfig()).resolves.toBe(contents);
  });

  it('should report no config rather than throwing when the file is absent', async () => {
    // A machine that has never run `docker login` is an ordinary state, not
    // an error the check has to survive.
    process.env['DOCKER_CONFIG'] = await mkdtemp(join(tmpdir(), 'infra-tools-docker-'));

    await expect(localDockerCredentials.readDockerConfig()).resolves.toBeUndefined();
  });

  it('should refuse to spawn a credential helper whose name is not a plain identifier', async () => {
    // The name comes out of config.json, which any process on the machine
    // can write, and it is interpolated into a command name. This is the
    // boundary that has to refuse it.
    await expect(localDockerCredentials.runCredentialHelper('a; rm -rf /', 'private.example.com')).rejects.toThrow(/refusing/iu);
  });

  it('should reject, rather than resolve empty, when the helper does not exist', async () => {
    // A rejection is what the chain reads as a miss, so it falls through to
    // the plaintext entry instead of aborting the check.
    await expect(localDockerCredentials.runCredentialHelper('infra-tools-no-such-helper', 'private.example.com')).rejects.toThrow();
  });
});
