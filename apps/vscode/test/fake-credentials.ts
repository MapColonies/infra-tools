import type { CredentialEnvironment } from 'oci-registry';

/**
 * A machine that has never run `docker login`.
 *
 * The extension's tests assert wiring, not credential resolution — that
 * lives behind the registry package's own entry point and is tested there —
 * so they all want the same empty environment, and reaching a registry at
 * all means naming one on that package's public list.
 */
const noDockerCredentials: CredentialEnvironment = {
  /* eslint-disable @typescript-eslint/promise-function-async -- canned answers, nothing to await */
  readDockerConfig: () => Promise.resolve(undefined),
  runCredentialHelper: () => Promise.reject(new Error('no credential helper is installed')),
  /* eslint-enable @typescript-eslint/promise-function-async */
};

export { noDockerCredentials };
