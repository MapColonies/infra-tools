import { acquireBearerToken, basicAuthorizationHeader, parseAuthenticateChallenge } from './authorize';
import type { CredentialEnvironment, RegistryCredential } from './credentials';
import { isPublicRegistry, resolveRegistryCredential } from './credentials';
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

// The OCI tag grammar. Validated up front, before any URL is built, so a
// crafted tag (`../../other-endpoint`, `latest?x=`) never reaches the
// request as anything other than the rejected reference it is.
const TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

interface CheckImageExistenceParams {
  readonly repository: string;
  readonly tag: string;
  readonly fetch: FetchLike;
  readonly credentials: CredentialEnvironment;
}

/**
 * Checks whether an image reference exists on a container registry.
 *
 * This is the package's single entry point: everything else — host
 * detection, credential resolution, the request shape, the distinction
 * between a missing repository and a missing tag — is reached only through
 * here, on purpose, so a test asserts the requests issued and the verdict
 * returned rather than an internal function.
 *
 * Only a fully-qualified repository (one naming an explicit registry host)
 * is supported so far — no document/registry fallback, no Docker Hub
 * fallback. Credentials come from the local Docker config and nowhere else:
 * this package never prompts, and never invents one. Anything it cannot
 * resolve, reach, or interpret comes back as `'unverifiable'`, never as a
 * false negative.
 */
async function checkImageExistence(params: CheckImageExistenceParams): Promise<ImageVerdict> {
  const { repository, tag, fetch, credentials } = params;
  const location = resolveExplicitHost(repository);

  if (location === undefined) {
    return { kind: 'unverifiable', reason: 'no-registry' };
  }

  if (!TAG_PATTERN.test(tag)) {
    return { kind: 'unverifiable', reason: 'malformed-reference' };
  }

  const { host, name } = location;
  const credential = await resolveRegistryCredential(host, credentials);

  // Resolved before the first request, not after a 401, because an
  // unlisted registry we hold no credential for must not be contacted at
  // all: the anonymous attempt discloses a private repository name to
  // whoever answers, and its 401 says nothing the config did not already.
  if (credential === undefined && !isPublicRegistry(host)) {
    return { kind: 'unverifiable', reason: 'needs-login', registry: host };
  }

  const url = new URL(`https://${host}/v2/${name}/manifests/${tag}`);

  let response: FetchResponseLike;

  try {
    response = await fetch(url.href, { method: 'GET', headers: { accept: MANIFEST_ACCEPT_HEADER } });

    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
      const authorization = await resolveAuthorization({ response, credential, repositoryName: name, fetch });

      if (authorization === undefined) {
        return { kind: 'unverifiable', reason: 'authentication-failure' };
      }

      response = await fetch(url.href, { method: 'GET', headers: { accept: MANIFEST_ACCEPT_HEADER, authorization } });

      // A second 401 means the credential itself was refused. Reported as
      // an authentication failure rather than a not-found, because a
      // registry is entitled to answer 401 for a repository the caller is
      // not allowed to know about, and reading that as "missing" is the
      // false negative this package exists to avoid.
      if (response.status === HTTP_STATUS_UNAUTHORIZED) {
        return { kind: 'unverifiable', reason: 'authentication-failure' };
      }
    }
  } catch {
    return { kind: 'unverifiable', reason: 'network-error' };
  }

  if (response.ok) {
    return { kind: 'exists', registry: host };
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

interface ResolveAuthorizationParams {
  readonly response: FetchResponseLike;
  readonly credential: RegistryCredential | undefined;
  readonly repositoryName: string;
  readonly fetch: FetchLike;
}

/**
 * Works out the `authorization` header a 401 is asking for, or `undefined`
 * when this package cannot satisfy the challenge.
 *
 * The registry's own challenge decides the scheme rather than the shape of
 * the credential we happen to hold. A bearer challenge answered with basic
 * credentials, or an identity token presented as a password, is refused by
 * every registry that issues either, so the credential is matched to what
 * was asked for and anything that doesn't line up comes back empty.
 */
async function resolveAuthorization(params: ResolveAuthorizationParams): Promise<string | undefined> {
  const { response, credential, repositoryName, fetch } = params;
  const header = response.headers.get('www-authenticate');

  if (header === null) {
    return undefined;
  }

  const challenge = parseAuthenticateChallenge(header);

  if (challenge === undefined) {
    return undefined;
  }

  if (challenge.scheme === 'bearer') {
    const token = await acquireBearerToken({ challenge, credential, repositoryName, fetch });
    return token === undefined ? undefined : `Bearer ${token}`;
  }

  return credential?.kind === 'basic' ? basicAuthorizationHeader(credential) : undefined;
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
