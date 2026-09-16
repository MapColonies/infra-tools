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

function dockerCredentials(params: DockerCredentialsParams = {}): CredentialEnvironment {
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
      fetch,
      credentials: dockerCredentials(),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://docker.io/v2/library/nginx/manifests/1.19', {
      method: 'GET',
      headers: { accept: MANIFEST_ACCEPT_HEADER },
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should report repository-not-found on a 404 whose body carries NAME_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: distributionError('NAME_UNKNOWN') }));

    const verdict = await checkImageExistence({
      repository: 'ghcr.io/example/does-not-exist',
      tag: '1.0.0',
      fetch,
      credentials: dockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'repository-not-found', repository: 'ghcr.io/example/does-not-exist' });
  });

  it('should report tag-not-found on a 404 whose body carries MANIFEST_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 404, body: distributionError('MANIFEST_UNKNOWN') }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: 'does-not-exist',
      fetch,
      credentials: dockerCredentials(),
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
      fetch,
      credentials: dockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'unexpected-response' });
  });

  it('should report needs-login, without contacting the registry, when a non-public registry has no local credential', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'private.example.com/app',
      tag: '1.0.0',
      fetch,
      credentials: dockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'needs-login', registry: 'private.example.com' });
  });

  it('should report unverifiable on a network failure rather than surfacing the error', async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const verdict = await checkImageExistence({
      repository: 'ghcr.io/example/app',
      tag: '1.0.0',
      fetch,
      credentials: dockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'network-error' });
  });

  it('should report unverifiable on an unexpected status code', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 500, body: {} }));

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '1.19',
      fetch,
      credentials: dockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'unexpected-response' });
  });

  it('should report unverifiable without issuing a request when the repository names no explicit host', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({ repository: 'nginx', tag: 'latest', fetch, credentials: dockerCredentials() });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'no-registry' });
  });

  it('should report unverifiable without issuing a request when the host segment smuggles userinfo', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'docker.io@evil.example/library/nginx',
      tag: '1.19',
      fetch,
      credentials: dockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'no-registry' });
  });

  it('should report unverifiable without issuing a request when a name component is a dot-segment', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'docker.io/../secrets',
      tag: '1.19',
      fetch,
      credentials: dockerCredentials(),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'no-registry' });
  });

  it('should report unverifiable without issuing a request when the tag does not fit the OCI tag grammar', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({
      repository: 'docker.io/library/nginx',
      tag: '../../other',
      fetch,
      credentials: dockerCredentials(),
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
      fetch,
      credentials: dockerCredentials({ config: { auths: { 'private.example.com': { auth: encodeAuth('dev', 's3cret') } } } }),
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
      fetch,
      credentials: dockerCredentials({
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
      fetch,
      credentials: dockerCredentials({
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
      fetch,
      credentials: dockerCredentials({
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
      fetch,
      credentials: dockerCredentials(),
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
      fetch,
      credentials: dockerCredentials({ config: { auths: { 'private.example.com': { auth: encodeAuth('dev', 'expired') } } } }),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'authentication-failure' });
  });

  it('should report authentication-failure when a 401 carries no challenge to act on', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(fakeFetchResponse({ status: 401, body: {} }));

    const verdict = await checkImageExistence({
      repository: 'ghcr.io/example/app',
      tag: '1.0.0',
      fetch,
      credentials: dockerCredentials(),
    });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'authentication-failure' });
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
      fetch,
      credentials: dockerCredentials({
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
      fetch,
      credentials: dockerCredentials({
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
      fetch,
      credentials: dockerCredentials({
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
      fetch,
      credentials: dockerCredentials({ config: { auths: { 'private.example.com': { auth: encodeAuth('dev', 's3cret') } } } }),
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
      fetch,
      credentials: dockerCredentials({ config: { credHelpers: { 'private.example.com': 'acr-env' } }, runCredentialHelper }),
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
      fetch,
      credentials: dockerCredentials({
        configText: `{ "auths": { "private.example.com": { "auth": "${encodeAuth('dev', 's3cret')}" }, } }`,
      }),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'needs-login', registry: 'private.example.com' });
  });
});
