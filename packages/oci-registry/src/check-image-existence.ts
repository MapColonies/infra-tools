import { acquireBearerToken, basicAuthorizationHeader, parseAuthenticateChallenge } from './authorize';
import type { CredentialEnvironment, RegistryCredential } from './credentials';
import { registryEndpoint } from './docker-hub';
import { isPublicRegistry, resolveRegistryCredential } from './credentials';
import type { FetchLike, FetchResponseLike } from './fetch-like';
import { resolveReference } from './resolve-reference';
import type { ResolvedReference } from './resolve-reference';
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
  /**
   * A registry declared elsewhere in the same document, or `undefined` when
   * the document declares none. Required rather than optional so that a
   * caller with nothing to say has to say so, instead of a forgotten field
   * silently downgrading a resolvable reference into a Docker Hub guess.
   */
  readonly documentRegistry: string | undefined;
  readonly fetch: FetchLike;
  readonly credentials: CredentialEnvironment;
}

/**
 * Checks whether an image reference exists on a container registry.
 *
 * This is the package's single entry point: everything else — registry
 * resolution, credential resolution, the request shape, the distinction
 * between a missing repository and a missing tag — is reached only through
 * here, on purpose, so a test asserts the requests issued and the verdict
 * returned rather than an internal function.
 *
 * The registry is resolved in three steps: a host the repository names
 * itself, else `documentRegistry`, else Docker Hub. That last step is a
 * guess, so a not-found from it is downgraded to `'guessed-registry'`, for
 * the reason recorded on that member of {@link UnverifiableReason}. A
 * positive answer from the guess still stands, so public images keep
 * verifying.
 *
 * Credentials come from the local Docker config and nowhere else: this
 * package never prompts, and never invents one. Anything it cannot resolve,
 * reach, or interpret comes back as `'unverifiable'`, never as a false
 * negative.
 */
async function checkImageExistence(params: CheckImageExistenceParams): Promise<ImageVerdict> {
  const { repository, tag, documentRegistry, fetch, credentials } = params;
  const reference = resolveReference(repository, documentRegistry);

  if (reference === undefined || !TAG_PATTERN.test(tag)) {
    return { kind: 'unverifiable', reason: 'malformed-reference' };
  }

  const verdict = await checkResolvedReference({ repository, reference, tag, fetch, credentials });
  const registryWasGuessed = reference.source === 'docker-hub-fallback';
  const answeredNotFound = verdict.kind === 'repository-not-found' || verdict.kind === 'tag-not-found';

  return registryWasGuessed && answeredNotFound ? { kind: 'unverifiable', reason: 'guessed-registry' } : verdict;
}

interface CheckResolvedReferenceParams {
  /** The repository as the file wrote it, which is what a not-found verdict names. */
  readonly repository: string;
  readonly reference: ResolvedReference;
  readonly tag: string;
  readonly fetch: FetchLike;
  readonly credentials: CredentialEnvironment;
}

/**
 * Asks one registry about one reference.
 *
 * Split out so the guess-downgrade applies to a single returned verdict
 * rather than to each not-found branch below. Spread across the branches,
 * the rule would be one edit away from a 404 path that reports a missing
 * image on the strength of a registry nobody named.
 */
async function checkResolvedReference(params: CheckResolvedReferenceParams): Promise<ImageVerdict> {
  const { repository, reference, tag, fetch, credentials } = params;
  const { host, name } = reference;
  const credential = await resolveRegistryCredential(host, credentials);

  // Resolved before the first request, not after a 401, because an
  // unlisted registry we hold no credential for must not be contacted at
  // all: the anonymous attempt discloses a private repository name to
  // whoever answers, and its 401 says nothing the config did not already.
  if (credential === undefined && !isPublicRegistry(host)) {
    return { kind: 'unverifiable', reason: 'needs-login', registry: host };
  }

  // The request goes to the host that serves the distribution API, which is
  // not always the host the file names; the verdict keeps naming the one the
  // file does, so a Hub image is not annotated with an endpoint nobody
  // wrote down.
  const url = new URL(`https://${registryEndpoint(host)}/v2/${name}/manifests/${tag}`);

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
