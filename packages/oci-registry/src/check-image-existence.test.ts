import { describe, expect, it, vi } from 'vitest';
import { checkImageExistence } from './check-image-existence';
import type { FetchLike, FetchResponseLike } from './fetch-like';

function jsonResponse(status: number, body: unknown): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- trivial canned response, nothing to await
    json: () => Promise.resolve(body),
  };
}

function distributionError(code: string): { errors: { code: string }[] } {
  return { errors: [{ code }] };
}

describe('checkImageExistence', () => {
  it('should issue a manifest GET with the OCI/Docker accept header and report exists on a 200', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { schemaVersion: 2 }));

    const verdict = await checkImageExistence({ repository: 'docker.io/library/nginx', tag: '1.19', fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://docker.io/v2/library/nginx/manifests/1.19', {
      method: 'GET',
      headers: {
        accept: [
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
        ].join(', '),
      },
    });
    expect(verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
  });

  it('should report repository-not-found on a 404 whose body carries NAME_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(404, distributionError('NAME_UNKNOWN')));

    const verdict = await checkImageExistence({ repository: 'ghcr.io/example/does-not-exist', tag: '1.0.0', fetch });

    expect(verdict).toEqual({ kind: 'repository-not-found', repository: 'ghcr.io/example/does-not-exist' });
  });

  it('should report tag-not-found on a 404 whose body carries MANIFEST_UNKNOWN', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(404, distributionError('MANIFEST_UNKNOWN')));

    const verdict = await checkImageExistence({ repository: 'docker.io/library/nginx', tag: 'does-not-exist', fetch });

    expect(verdict).toEqual({
      kind: 'tag-not-found',
      repository: 'docker.io/library/nginx',
      tag: 'does-not-exist',
    });
  });

  it('should report unverifiable, never a false negative, when a 404 body carries no recognised code', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(404, {}));

    const verdict = await checkImageExistence({ repository: 'docker.io/library/nginx', tag: '1.19', fetch });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'unexpected-response' });
  });

  it('should report unverifiable when the registry demands authentication this package cannot provide', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(401, {}));

    const verdict = await checkImageExistence({ repository: 'private.example.com/app', tag: '1.0.0', fetch });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'missing-credential' });
  });

  it('should report unverifiable on a network failure rather than surfacing the error', async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const verdict = await checkImageExistence({ repository: 'unreachable.example.com/app', tag: '1.0.0', fetch });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'network-error' });
  });

  it('should report unverifiable on an unexpected status code', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(500, {}));

    const verdict = await checkImageExistence({ repository: 'docker.io/library/nginx', tag: '1.19', fetch });

    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'unexpected-response' });
  });

  it('should report unverifiable without issuing a request when the repository names no explicit host', async () => {
    const fetch = vi.fn<FetchLike>();

    const verdict = await checkImageExistence({ repository: 'nginx', tag: 'latest', fetch });

    expect(fetch).not.toHaveBeenCalled();
    expect(verdict).toEqual({ kind: 'unverifiable', reason: 'no-registry' });
  });
});
