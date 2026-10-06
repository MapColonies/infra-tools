import { describe, expect, it, vi } from 'vitest';
import { checkImageExistence } from './check-image-existence';
import type { CredentialEnvironment } from './credentials';
import type { FetchLike, FetchRequestInit, FetchResponseLike } from './fetch-like';

const MANIFEST_ACCEPT_HEADER = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

interface FakeResponseParams {
  readonly status: number;
  readonly body?: unknown;
  readonly wwwAuthenticate?: string;
}

function fakeFetchResponse(params: FakeResponseParams): FetchResponseLike {
  const { status, body, wwwAuthenticate } = params;

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'www-authenticate' ? (wwwAuthenticate ?? null) : null) },
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- trivial canned response, nothing to await
    json: () => Promise.resolve(body),
  };
}

/** The shape of `~/.docker/config.json` a test cares about, spelled out so each test reads as a developer's real config file. */
interface DockerConfigFile {
  readonly auths?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly credsStore?: string;
  readonly credHelpers?: Readonly<Record<string, string>>;
}

interface DockerCredentialsParams {
  readonly config?: DockerConfigFile;
  /** Config text written out verbatim, for the cases where it is deliberately not valid JSON. */
  readonly configText?: string;
  readonly runCredentialHelper?: CredentialEnvironment['runCredentialHelper'];
}

function fakeDockerCredentials(params: DockerCredentialsParams = {}): CredentialEnvironment {
  const { config, configText, runCredentialHelper } = params;
  const contents = configText ?? (config === undefined ? undefined : JSON.stringify(config));

  return {
    readDockerConfig: vi.fn<CredentialEnvironment['readDockerConfig']>().mockResolvedValue(contents),
    runCredentialHelper:
      runCredentialHelper ?? vi.fn<CredentialEnvironment['runCredentialHelper']>().mockRejectedValue(new Error('no credential helper is installed')),
  };
}

interface HelperOutputParams {
  readonly serverUrl: string;
  readonly username: string;
  readonly secret: string;
}

/** Stdout from a `docker-credential-*` helper. The capitalised keys are that protocol's wire format, not a name this repo chose. */
function helperOutput(params: HelperOutputParams): string {
  const { serverUrl, username, secret } = params;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- credential-helper wire field names
  return JSON.stringify({ ServerURL: serverUrl, Username: username, Secret: secret });
}

function encodeAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`).toString('base64');
}

/** Reads the nth `fetch` call, throwing rather than handing `undefined` to an assertion that would then pass vacuously. */
function requestAt(calls: readonly (readonly [string, FetchRequestInit])[], index: number): { url: string; init: FetchRequestInit } {
  const call = calls[index];

  if (call === undefined) {
    throw new Error(`expected a fetch call at index ${index}, got ${calls.length}`);
  }

  const [url, init] = call;
  return { url, init };
}

function distributionError(code: string): { errors: { code: string }[] } {
  return { errors: [{ code }] };
}

describe('checkImageExistence', () => {
  it('should issue a manifest GET with the OCI/Docker accept header and report exists on a 200', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://registry-1.docker.io/v2/library/nginx/manifests/1.19', {
      method: 'GET',
      headers: { accept: MANIFEST_ACCEPT_HEADER },
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should send a docker.io reference to the host that serves the API, while still reporting docker.io', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // `docker.io` redirects a manifest GET to the marketing site, which
    // answers 200. Requesting it would report every Hub image as existing,
    // missing tags included — the one wrong answer a checkmark cannot
    // survive. Only `registry-1.docker.io` serves the distribution API.
    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/1.19');

    // The verdict names the registry the file did, so the mark stays quiet
    // instead of appending an endpoint nobody wrote down.
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should report repository-not-found on a 404 whose body carries NAME_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: distributionError('NAME_UNKNOWN') }));

    const verdict = await checkImageExistence({
      repository: 'ghcr.io/example/does-not-exist',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'repository-not-found', repository: 'ghcr.io/example/does-not-exist' });
  });

  it('should report tag-not-found on a 404 whose body carries MANIFEST_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: distributionError('MANIFEST_UNKNOWN') }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: 'does-not-exist',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(verdict).toEqual({
      kind: 'tag-not-found',
      repository: 'docker.io/library/nginx',
      tag: 'does-not-exist',
    });
  });

  it('should report unverifiable, never a false negative, when a 404 body carries no recognised code', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: {} }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'unexpected-response' });
  });

  it('should report needs-login, without contacting the registry, when a non-public registry has no local credential', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'needs-login', registry: 'private.example.com' });
  });

  it('should report unverifiable on a network failure rather than surfacing the error', async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const verdict = await checkImageExistence({
      repository: 'ghcr.io/example/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'network-error' });
  });

  it('should report unverifiable on an unexpected status code', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 500, body: {} }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'unexpected-response' });
  });

  it('should send a repository that names no registry to Docker Hub, under the library namespace a single-segment name lives in', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'nginx',
      tag: 'latest',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/latest');
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should prefix the library namespace onto a single-segment name a repository qualifies with docker.io itself', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // Docker's normalization is a property of Hub, not of how the host was
    // arrived at: `docker.io/nginx` addresses the same repository the bare
    // `nginx` does.
    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://registry-1.docker.io/v2/library/nginx/manifests/1.19');
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should request a repository that names no registry against the one declared for it', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'example/app',
      tag: '1.0.0',
      declaredRegistry: 'ghcr.io',
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://ghcr.io/v2/example/app/manifests/1.0.0');
    expect(verdict).toEqual({ kind: 'exists', registry: 'ghcr.io' });
  });

  it('should prefer a host the repository names over a declared registry', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'quay.io/example/app',
      tag: '1.0.0',
      declaredRegistry: 'ghcr.io',
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://quay.io/v2/example/app/manifests/1.0.0');
    expect(verdict).toEqual({ kind: 'exists', registry: 'quay.io' });
  });

  it('should treat localhost:5000 as a host the repository names rather than a name on the declared registry', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'localhost:5000/svc',
      tag: '1.0.0',
      declaredRegistry: 'ghcr.io',
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({ config: { auths: { 'localhost:5000': { auth: encodeAuth('dev', 's3cret') } } } }),
    });

    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://localhost:5000/v2/svc/manifests/1.0.0');
    expect(verdict).toEqual({ kind: 'exists', registry: 'localhost:5000' });
  });

  it('should treat a first segment with no dot, colon, or localhost as a namespace rather than a host', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'bitnami/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // `bitnami` is a Hub namespace. Reading it as a host would send the
    // request to a machine that does not exist, and the library prefix would
    // wrongly apply to a name that already has two segments.
    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://registry-1.docker.io/v2/bitnami/nginx/manifests/1.19');
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should report guessed-registry, never tag-not-found, when the guessed Docker Hub answers MANIFEST_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: distributionError('MANIFEST_UNKNOWN') }));

    const verdict = await checkImageExistence({
      repository: 'discrete-agent',
      tag: 'v3.2.1',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // Nothing in the file named Hub. An internal service absent from it is
    // the common case in this organisation's charts, so the 404 is evidence
    // about the guess, not about the image.
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'guessed-registry' });
  });

  it('should report guessed-registry, never repository-not-found, when the guessed Docker Hub answers NAME_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: distributionError('NAME_UNKNOWN') }));

    const verdict = await checkImageExistence({
      repository: 'discrete-agent',
      tag: 'v3.2.1',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'guessed-registry' });
  });

  it('should report repository-not-found when a declared registry answers NAME_UNKNOWN, which is not a guess', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: distributionError('NAME_UNKNOWN') }));

    const verdict = await checkImageExistence({
      repository: 'example/does-not-exist',
      tag: '1.0.0',
      declaredRegistry: 'ghcr.io',
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // The caller said where to look, so a not-found from there is the
    // answer to the question the file asked. Downgrading it too would leave
    // the checker unable to report a missing image at all.
    expect(verdict).toEqual({ kind: 'repository-not-found', repository: 'example/does-not-exist' });
  });

  it('should report malformed-reference without issuing a request when the repository fits no valid name grammar', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'Not A Name',
      tag: '1.0.0',
      declaredRegistry: 'ghcr.io',
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'malformed-reference' });
  });

  it('should treat an empty declared registry as nothing declared rather than as a registry named badly', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'example/app',
      tag: '1.0.0',
      declaredRegistry: '',
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestAt(fetch.mock.calls, 0).url).toBe('https://registry-1.docker.io/v2/example/app/manifests/1.0.0');
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should report malformed-reference without issuing a request when the declared registry is not a valid host', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'example/app',
      tag: '1.0.0',
      declaredRegistry: 'https://registry.example.com',
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // Falling back to Hub here would answer a question about a registry the
    // caller did name, and `https://…` reaches `fetch` as userinfo if it
    // is pasted into the URL template unchecked.
    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'malformed-reference' });
  });

  it('should report malformed-reference without issuing a request when the host segment smuggles userinfo', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'docker.io@evil.example/library/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'malformed-reference' });
  });

  it('should report malformed-reference without issuing a request when a name component is a dot-segment', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'docker.io/../secrets',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // The rejected explicit host must not fall through to the Hub guess:
    // the whole string is then offered as a name, and `..` has to fail that
    // grammar too or the traversal arrives at Hub instead.
    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'malformed-reference' });
  });

  it('should report unverifiable without issuing a request when the tag does not fit the OCI tag grammar', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '../../other',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'malformed-reference' });
  });

  it('should send a plaintext auths credential as basic on the token request and the issued token on the manifest retry', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://private.example.com/oauth2/token",service="private.example.com",scope="repository:app:pull"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'issued-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({ config: { auths: { 'private.example.com': { auth: encodeAuth('dev', 's3cret') } } } }),
    });

    const token = requestAt(fetch.mock.calls, 1);
    const tokenUrl = new URL(token.url);

    expect(token.init.method).toBe('GET');
    expect(`${tokenUrl.origin}${tokenUrl.pathname}`).toBe('https://private.example.com/oauth2/token');
    expect(tokenUrl.searchParams.get('service')).toBe('private.example.com');
    expect(tokenUrl.searchParams.get('scope')).toBe('repository:app:pull');
    expect(token.init.headers).toEqual({ authorization: `Basic ${encodeAuth('dev', 's3cret')}` });

    expect(fetch).toHaveBeenNthCalledWith(3, 'https://private.example.com/v2/app/manifests/1.0.0', {
      method: 'GET',
      headers: { accept: MANIFEST_ACCEPT_HEADER, authorization: 'Bearer issued-token' },
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'private.example.com' });
  });

  it('should resolve a credential through the global credsStore, handing the helper the config key it matched', async () => {
    const runCredentialHelper = vi
      .fn<CredentialEnvironment['runCredentialHelper']>()
      .mockResolvedValue(helperOutput({ serverUrl: 'https://private.example.com', username: 'store-user', secret: 'store-secret' }));
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://private.example.com/oauth2/token",service="private.example.com"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'issued-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        config: { credsStore: 'desktop', auths: { 'https://private.example.com': {} } },
        runCredentialHelper,
      }),
    });

    expect(runCredentialHelper).toHaveBeenCalledWith('desktop', 'https://private.example.com');

    const token = requestAt(fetch.mock.calls, 1);

    expect(new URL(token.url).searchParams.get('scope')).toBe('repository:app:pull');
    expect(token.init.headers).toEqual({ authorization: `Basic ${encodeAuth('store-user', 'store-secret')}` });
    expect(verdict).toEqual({ kind: 'exists', registry: 'private.example.com' });
  });

  it('should prefer a per-registry credHelpers entry over the global credsStore', async () => {
    const runCredentialHelper = vi
      .fn<CredentialEnvironment['runCredentialHelper']>()
      .mockResolvedValue(helperOutput({ serverUrl: 'private.example.com', username: 'helper-user', secret: 'helper-secret' }));
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://private.example.com/oauth2/token",service="private.example.com"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'issued-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        config: { credsStore: 'desktop', credHelpers: { 'private.example.com': 'acr-env' } },
        runCredentialHelper,
      }),
    });

    expect(runCredentialHelper).toHaveBeenCalledTimes(1);
    expect(runCredentialHelper).toHaveBeenCalledWith('acr-env', 'private.example.com');
    expect(requestAt(fetch.mock.calls, 1).init.headers).toEqual({
      authorization: `Basic ${encodeAuth('helper-user', 'helper-secret')}`,
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'private.example.com' });
  });

  it('should fall through to the plaintext entry, not to the global credsStore, when a per-registry helper misses', async () => {
    const runCredentialHelper = vi
      .fn<CredentialEnvironment['runCredentialHelper']>()
      .mockRejectedValue(new Error('credentials not found in native keychain'));
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://private.example.com/oauth2/token",service="private.example.com"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'issued-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        config: {
          credsStore: 'desktop',
          credHelpers: { 'private.example.com': 'acr-env' },
          auths: { 'private.example.com': { auth: encodeAuth('dev', 's3cret') } },
        },
        runCredentialHelper,
      }),
    });

    // Docker picks exactly one store per registry, so a `credHelpers` entry
    // replaces the global one instead of being tried ahead of it. Asking
    // `desktop` here would verify with a credential `docker pull` would
    // never send.
    expect(runCredentialHelper).toHaveBeenCalledTimes(1);
    expect(runCredentialHelper).toHaveBeenCalledWith('acr-env', 'private.example.com');
    expect(requestAt(fetch.mock.calls, 1).init.headers).toEqual({ authorization: `Basic ${encodeAuth('dev', 's3cret')}` });
    expect(verdict).toEqual({ kind: 'exists', registry: 'private.example.com' });
  });

  it('should exchange the identity token rather than the empty-password basic credential an ACR auth entry decodes to', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://myorg.azurecr.io/oauth2/token",service="myorg.azurecr.io"',
        })
      )
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 200,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- the OAuth2 wire field name the registry actually returns
          body: { access_token: 'acr-access-token' },
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'myorg.azurecr.io/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        config: {
          auths: {
            'myorg.azurecr.io': {
              auth: encodeAuth('00000000-0000-0000-0000-000000000000', ''),
              identitytoken: 'refresh-token-value',
            },
          },
        },
      }),
    });

    const token = requestAt(fetch.mock.calls, 1);
    const body = new URLSearchParams(token.init.body ?? '');

    expect(token.url).toBe('https://myorg.azurecr.io/oauth2/token');
    expect(token.init.method).toBe('POST');
    expect(token.init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-token-value');
    expect(body.get('service')).toBe('myorg.azurecr.io');
    expect(body.get('scope')).toBe('repository:app:pull');
    expect(body.get('client_id')).toBe('infra-tools');

    expect(fetch).toHaveBeenNthCalledWith(3, 'https://myorg.azurecr.io/v2/app/manifests/1.0.0', {
      method: 'GET',
      headers: { accept: MANIFEST_ACCEPT_HEADER, authorization: 'Bearer acr-access-token' },
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'myorg.azurecr.io' });
  });

  it('should acquire a token anonymously when a public registry challenges and no credential matches', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:example/app:pull"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'anonymous-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'ghcr.io/example/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestAt(fetch.mock.calls, 1).init.headers).toEqual({});
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://ghcr.io/v2/example/app/manifests/1.0.0', {
      method: 'GET',
      headers: { accept: MANIFEST_ACCEPT_HEADER, authorization: 'Bearer anonymous-token' },
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'ghcr.io' });
  });

  it('should report authentication-failure, never a not-found verdict, when the registry rejects the credential it was given', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://private.example.com/oauth2/token",service="private.example.com"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'stale-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 401, body: {} }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({ config: { auths: { 'private.example.com': { auth: encodeAuth('dev', 'expired') } } } }),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'authentication-failure' });
  });

  it('should report authentication-failure when a 401 carries no challenge to act on', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 401, body: {} }));

    const verdict = await checkImageExistence({
      repository: 'ghcr.io/example/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'authentication-failure' });
  });

  it('should refuse a plaintext token endpoint rather than put the credential on the wire in the clear', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      fakeFetchResponse({
        status: 401,
        body: {},
        wwwAuthenticate: 'Bearer realm="http://private.example.com/oauth2/token",service="private.example.com"',
      })
    );

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({ config: { auths: { 'private.example.com': { auth: encodeAuth('dev', 's3cret') } } } }),
    });

    // Whoever answered the manifest request chose that realm, and the
    // request built from it is the one carrying the password.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'authentication-failure' });
  });

  it('should allow a plaintext token endpoint on loopback, where a local registry has no certificate', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({ status: 401, body: {}, wwwAuthenticate: 'Bearer realm="http://localhost:5000/token",service="localhost:5000"' })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'issued-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'localhost:5000/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({ config: { auths: { 'localhost:5000': { auth: encodeAuth('dev', 's3cret') } } } }),
    });

    expect(requestAt(fetch.mock.calls, 1).url).toBe('http://localhost:5000/token?service=localhost%3A5000&scope=repository%3Aapp%3Apull');
    expect(verdict).toEqual({ kind: 'exists', registry: 'localhost:5000' });
  });

  it('should fall through to the plaintext auths entry when the credential helper rejects', async () => {
    const runCredentialHelper = vi
      .fn<CredentialEnvironment['runCredentialHelper']>()
      .mockRejectedValue(new Error('credentials not found in native keychain'));
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://private.example.com/oauth2/token",service="private.example.com"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'issued-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        config: { credsStore: 'desktop', auths: { 'private.example.com': { auth: encodeAuth('dev', 's3cret') } } },
        runCredentialHelper,
      }),
    });

    expect(runCredentialHelper).toHaveBeenCalledWith('desktop', 'private.example.com');
    expect(requestAt(fetch.mock.calls, 1).init.headers).toEqual({ authorization: `Basic ${encodeAuth('dev', 's3cret')}` });
    expect(verdict).toEqual({ kind: 'exists', registry: 'private.example.com' });
  });

  it('should match a Docker Hub config key written as https://index.docker.io/v1/ against a docker.io reference', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { token: 'hub-token' } }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        config: { auths: { 'https://index.docker.io/v1/': { auth: encodeAuth('hub-user', 'hub-secret') } } },
      }),
    });

    const token = requestAt(fetch.mock.calls, 1);

    expect(new URL(token.url).searchParams.get('scope')).toBe('repository:library/nginx:pull');
    expect(token.init.headers).toEqual({ authorization: `Basic ${encodeAuth('hub-user', 'hub-secret')}` });
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  // The ACR case above cannot prove the ordering on its own: its `auth` carries an empty
  // password, so the empty-password rule would reach the identity token whatever the order.
  // This entry pairs an identity token with a usable password, where only the order decides.
  it('should prefer an identity token over an auth field that would otherwise yield a usable basic credential', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://myorg.azurecr.io/oauth2/token",service="myorg.azurecr.io"',
        })
      )
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 200,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- the OAuth2 wire field name the registry actually returns
          body: { access_token: 'acr-access-token' },
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'myorg.azurecr.io/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        config: {
          auths: {
            'myorg.azurecr.io': { auth: encodeAuth('stale-user', 'stale-password'), identitytoken: 'refresh-token-value' },
          },
        },
      }),
    });

    const token = requestAt(fetch.mock.calls, 1);

    expect(token.init.method).toBe('POST');
    expect(token.init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(new URLSearchParams(token.init.body ?? '').get('refresh_token')).toBe('refresh-token-value');
    expect(verdict).toEqual({ kind: 'exists', registry: 'myorg.azurecr.io' });
  });

  it('should answer a Basic challenge by retrying the manifest request with the credential itself', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(fakeFetchResponse({ status: 401, body: {}, wwwAuthenticate: 'Basic realm="private.example.com"' }))
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({ config: { auths: { 'private.example.com': { auth: encodeAuth('dev', 's3cret') } } } }),
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://private.example.com/v2/app/manifests/1.0.0', {
      method: 'GET',
      headers: { accept: MANIFEST_ACCEPT_HEADER, authorization: `Basic ${encodeAuth('dev', 's3cret')}` },
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'private.example.com' });
  });

  it('should exchange a helper secret reported under the <token> username as a refresh token, not a password', async () => {
    const runCredentialHelper = vi
      .fn<CredentialEnvironment['runCredentialHelper']>()
      .mockResolvedValue(helperOutput({ serverUrl: 'private.example.com', username: '<token>', secret: 'helper-refresh-token' }));
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 401,
          body: {},
          wwwAuthenticate: 'Bearer realm="https://private.example.com/oauth2/token",service="private.example.com"',
        })
      )
      .mockResolvedValueOnce(
        fakeFetchResponse({
          status: 200,
          // eslint-disable-next-line @typescript-eslint/naming-convention -- the OAuth2 wire field name the registry actually returns
          body: { access_token: 'exchanged-token' },
        })
      )
      .mockResolvedValueOnce(fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } }));

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({ config: { credHelpers: { 'private.example.com': 'acr-env' } }, runCredentialHelper }),
    });

    const token = requestAt(fetch.mock.calls, 1);
    const body = new URLSearchParams(token.init.body ?? '');

    expect(token.init.method).toBe('POST');
    expect(token.init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('helper-refresh-token');
    expect(verdict).toEqual({ kind: 'exists', registry: 'private.example.com' });
  });

  // The credential spelled out in the unparseable text is what makes this non-vacuous: were the
  // config read at all, this registry would resolve a credential and reach the network instead.
  it('should treat a docker config whose JSON does not parse as an empty config', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: [],
      fetch,
      credentials: fakeDockerCredentials({
        configText: `{ "auths": { "private.example.com": { "auth": "${encodeAuth('dev', 's3cret')}" }, } }`,
      }),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'needs-login', registry: 'private.example.com' });
  });
});

/** A fetch answering each manifest URL from `responses`, rejecting any URL the test did not expect to be asked about. */
function fetchByUrl(responses: Readonly<Record<string, FetchResponseLike>>): ReturnType<typeof vi.fn<FetchLike>> {
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- canned responses, nothing to await
  return vi.fn<FetchLike>((url) => {
    const response = responses[url];

    return response === undefined ? Promise.reject(new Error(`unexpected request to ${url}`)) : Promise.resolve(response);
  });
}

/** Every URL a fake fetch was asked for, sorted, because the override set is queried concurrently. */
function requestedUrls(fetch: ReturnType<typeof vi.fn<FetchLike>>): string[] {
  return fetch.mock.calls.map(([url]) => url).sort();
}

const GHCR_MANIFEST_URL = 'https://ghcr.io/v2/team/app/manifests/1.0.0';
const QUAY_MANIFEST_URL = 'https://quay.io/v2/team/app/manifests/1.0.0';
const EXISTS = fakeFetchResponse({ status: 200, body: { schemaVersion: 2 } });
const MANIFEST_UNKNOWN = fakeFetchResponse({ status: 404, body: distributionError('MANIFEST_UNKNOWN') });
const NAME_UNKNOWN = fakeFetchResponse({ status: 404, body: distributionError('NAME_UNKNOWN') });

describe('checkImageExistence with a registry override set', () => {
  it('should query every override registry instead of the host the repository names, crediting the one that has it', async () => {
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: MANIFEST_UNKNOWN, [QUAY_MANIFEST_URL]: EXISTS });

    const verdict = await checkImageExistence({
      repository: 'registry.prod.example.com/team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['ghcr.io', 'quay.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL, QUAY_MANIFEST_URL]);
    expect(verdict).toEqual({ kind: 'exists', registry: 'quay.io' });
  });

  it('should replace a registry the document declares, not add to it', async () => {
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: EXISTS });

    const verdict = await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: 'registry.prod.example.com',
      overrideRegistries: ['ghcr.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL]);
    expect(verdict).toEqual({ kind: 'exists', registry: 'ghcr.io' });
  });

  it('should credit the first override registry in settings order when more than one has the image', async () => {
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: EXISTS, [QUAY_MANIFEST_URL]: EXISTS });

    const verdict = await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['quay.io', 'ghcr.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL, QUAY_MANIFEST_URL]);
    expect(verdict).toEqual({ kind: 'exists', registry: 'quay.io' });
  });

  it('should report tag-not-found naming the override set when no override registry has the tag', async () => {
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: NAME_UNKNOWN, [QUAY_MANIFEST_URL]: MANIFEST_UNKNOWN });

    const verdict = await checkImageExistence({
      repository: 'registry.prod.example.com/team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['ghcr.io', 'quay.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // The repository exists on one of them, so it is the tag that is
    // missing — the fix is a version, not a name.
    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL, QUAY_MANIFEST_URL]);
    expect(verdict).toEqual({
      kind: 'tag-not-found',
      repository: 'registry.prod.example.com/team/app',
      tag: '1.0.0',
      overrideRegistries: ['ghcr.io', 'quay.io'],
    });
  });

  it('should report repository-not-found naming the override set when no override registry has the repository', async () => {
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: NAME_UNKNOWN, [QUAY_MANIFEST_URL]: NAME_UNKNOWN });

    const verdict = await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['ghcr.io', 'quay.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL, QUAY_MANIFEST_URL]);
    expect(verdict).toEqual({ kind: 'repository-not-found', repository: 'team/app', overrideRegistries: ['ghcr.io', 'quay.io'] });
  });

  it('should trust a not-found for a name the file gave no registry, because the settings named where to look', async () => {
    const fetch = fetchByUrl({ 'https://ghcr.io/v2/discrete-agent/manifests/v3.2.1': MANIFEST_UNKNOWN });

    const verdict = await checkImageExistence({
      repository: 'discrete-agent',
      tag: 'v3.2.1',
      declaredRegistry: undefined,
      overrideRegistries: ['ghcr.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual(['https://ghcr.io/v2/discrete-agent/manifests/v3.2.1']);
    expect(verdict).toEqual({ kind: 'tag-not-found', repository: 'discrete-agent', tag: 'v3.2.1', overrideRegistries: ['ghcr.io'] });
  });

  it('should report unverifiable, never a not-found, when one override registry could not answer', async () => {
    // Quay is absent from the table, so its request rejects the way an unreachable host does.
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: MANIFEST_UNKNOWN });

    const verdict = await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['ghcr.io', 'quay.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    // The unreachable one may be exactly where the image was pushed.
    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL, QUAY_MANIFEST_URL]);
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'network-error' });
  });

  it('should report needs-login for an override registry with no credential, so the developer is prompted for it', async () => {
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: MANIFEST_UNKNOWN });

    const verdict = await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['ghcr.io', 'dev.example.com'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL]);
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'needs-login', registry: 'dev.example.com' });
  });

  it('should still credit a registry that has the image when another override registry could not answer', async () => {
    const fetch = fetchByUrl({ [QUAY_MANIFEST_URL]: EXISTS });

    const verdict = await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['dev.example.com', 'quay.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual([QUAY_MANIFEST_URL]);
    expect(verdict).toEqual({ kind: 'exists', registry: 'quay.io' });
  });

  it('should address a single-segment name on an override Docker Hub under the library namespace', async () => {
    const fetch = fetchByUrl({ 'https://registry-1.docker.io/v2/library/nginx/manifests/1.19': EXISTS });

    const verdict = await checkImageExistence({
      repository: 'registry.prod.example.com/nginx',
      tag: '1.19',
      declaredRegistry: undefined,
      overrideRegistries: ['docker.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual(['https://registry-1.docker.io/v2/library/nginx/manifests/1.19']);
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should query an override registry listed twice only once', async () => {
    const fetch = fetchByUrl({ [GHCR_MANIFEST_URL]: EXISTS });

    await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['ghcr.io', 'ghcr.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(requestedUrls(fetch)).toEqual([GHCR_MANIFEST_URL]);
  });

  it('should report malformed-reference without issuing a request when an override registry is not a valid host', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'team/app',
      tag: '1.0.0',
      declaredRegistry: undefined,
      overrideRegistries: ['https://ghcr.io'],
      fetch,
      credentials: fakeDockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'malformed-reference' });
  });
});
