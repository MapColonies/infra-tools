import type { FetchLike, FetchResponseLike } from './fetch-like';
import { resolveExplicitHost } from './resolve-explicit-host';
import type { ImageVerdict } from './verdict';

/**
 * Media types covering both OCI and Docker manifest and index shapes, so a
 * single request works against registries serving either — a `HEAD` cannot
 * distinguish an unknown repository from an unknown manifest (that
 * distinction lives only in a 404 response body), so the request has to be
 * a `GET` regardless of which of these media types comes back.
 */
const MANIFEST_ACCEPT_HEADER = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_NOT_FOUND = 404;

interface CheckImageExistenceParams {
  readonly repository: string;
  readonly tag: string;
  readonly fetch: FetchLike;
}

/**
 * Checks whether an image reference exists on a container registry.
 *
 * This is the package's single entry point: everything else — host
 * detection, the request shape, the distinction between a missing
 * repository and a missing tag — is reached only through here, on purpose,
 * so a test asserts the requests issued and the verdict returned rather
 * than an internal function.
 *
 * Only a fully-qualified repository (one naming an explicit registry host)
 * and only an anonymous request are supported so far — no document/registry
 * fallback, no Docker Hub fallback, no credential chain. Anything this
 * package cannot yet resolve, reach, or interpret comes back as
 * `'unverifiable'`, never as a false negative.
 */
async function checkImageExistence(params: CheckImageExistenceParams): Promise<ImageVerdict> {
  const { repository, tag, fetch } = params;
  const location = resolveExplicitHost(repository);

  if (location === undefined) {
    return { kind: 'unverifiable', reason: 'no-registry' };
  }

  const { host, name } = location;
  const url = `https://${host}/v2/${name}/manifests/${tag}`;

  let response: FetchResponseLike;
  try {
    response = await fetch(url, { method: 'GET', headers: { accept: MANIFEST_ACCEPT_HEADER } });
  } catch {
    return { kind: 'unverifiable', reason: 'network-error' };
  }

  if (response.ok) {
    return { kind: 'exists', registry: host };
  }

  // No credential handling yet — any auth challenge is unverifiable, never
  // a signal the image is missing.
  if (response.status === HTTP_STATUS_UNAUTHORIZED) {
    return { kind: 'unverifiable', reason: 'missing-credential' };
  }

  if (response.status === HTTP_STATUS_NOT_FOUND) {
    const code = await readErrorCode(response);

    if (code === 'NAME_UNKNOWN') {
      return { kind: 'repository-not-found', repository };
    }

    if (code === 'MANIFEST_UNKNOWN') {
      return { kind: 'tag-not-found', repository, tag };
    }

    return { kind: 'unverifiable', reason: 'unexpected-response' };
  }

  return { kind: 'unverifiable', reason: 'unexpected-response' };
}

interface DistributionErrorBody {
  readonly errors?: readonly { readonly code?: string }[];
}

/** Reads the distribution API error code out of a 404 response body. */
async function readErrorCode(response: FetchResponseLike): Promise<string | undefined> {
  try {
    const body = (await response.json()) as DistributionErrorBody;
    return body.errors?.[0]?.code;
  } catch {
    return undefined;
  }
}

export { checkImageExistence };
export type { CheckImageExistenceParams };
