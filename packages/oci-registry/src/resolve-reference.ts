import { DOCKER_HUB_HOST, DOCKER_HUB_LIBRARY_NAMESPACE, isDockerHub } from './docker-hub';

// A registry host: DNS-label characters and dots, with an optional numeric
// port. Anything outside this set — most pointedly `@`, which a raw
// `https://${host}/...` template would let a crafted repository string use
// to smuggle a different host into the request via URL userinfo — is
// rejected rather than sent to `fetch`.
const HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/;

// The OCI distribution spec's `name` grammar: one or more lowercase
// path components, each starting and ending alphanumeric, joined by `/`.
// A component can never be `.` or `..`, which is what keeps a crafted name
// from collapsing the manifest URL's path onto a neighbouring endpoint.
const NAME_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;

/** Where a repository resolved to: a registry host, and the image's name on it. */
interface RepositoryLocation {
  readonly host: string;
  readonly name: string;
}

/** How the registry a reference was checked against was arrived at. */
type RegistrySource = 'explicit' | 'declared' | 'docker-hub-fallback';

/** A repository string resolved to a registry host and a name on it, kept with how that host was arrived at. */
interface ResolvedReference extends RepositoryLocation {
  readonly source: RegistrySource;
}

/**
 * Detects an explicit registry host named in a repository string, using the
 * standard OCI/Docker rule: the first `/`-separated segment counts as a
 * host when it contains a dot or a colon, or is exactly `localhost`.
 *
 * Reference normalization is OCI naming semantics, not anything Helm- or
 * editor-specific, which is why it lives here rather than in the package
 * that extracted the raw string. This answers only what the string itself
 * names, which is the first step of {@link resolveReference} and separately
 * the whole question an editor asks when it wants to know whether a file
 * spelled its registry out. `undefined` therefore means "no explicit host",
 * not "no registry": deciding what to do about that is the caller's.
 */
function resolveExplicitHost(repository: string): RepositoryLocation | undefined {
  const segments = repository.split('/');
  const [firstSegment] = segments;
  const name = segments.slice(1).join('/');

  if (firstSegment === undefined || name === '') {
    return undefined;
  }

  const looksLikeHost = firstSegment === 'localhost' || firstSegment.includes('.') || firstSegment.includes(':');

  if (!looksLikeHost || !HOST_PATTERN.test(firstSegment) || !NAME_PATTERN.test(name)) {
    return undefined;
  }

  return { host: firstSegment, name };
}

/**
 * Resolves a repository string to the registry its image would be pulled
 * from: a host the string names itself, else the registry the caller says
 * was declared for it, else Docker Hub.
 *
 * `undefined` means the reference is malformed — a name outside the OCI
 * grammar, or a `declaredRegistry` that is not a host — and never "no
 * registry was found", because the last step always produces one. That last
 * step is a guess, which is why the answer carries its
 * {@link ResolvedReference.source}: a not-found from a registry nobody named
 * says something about the guess rather than about the image, and only the
 * source distinguishes the two.
 */
function resolveReference(repository: string, declaredRegistry: string | undefined): ResolvedReference | undefined {
  const reference = selectRegistry(repository, declaredRegistry);

  if (reference === undefined || !isDockerHub(reference.host) || reference.name.includes('/')) {
    return reference;
  }

  // Docker's own normalization, applied however the host was arrived at:
  // `nginx`, `docker.io/nginx` and a declared registry of `docker.io` all
  // address `library/nginx`, and Hub serves the long form only.
  return { ...reference, name: `${DOCKER_HUB_LIBRARY_NAMESPACE}/${reference.name}` };
}

/** Picks which of the three registry sources applies, before Hub name normalization. */
function selectRegistry(repository: string, declaredRegistry: string | undefined): ResolvedReference | undefined {
  const explicit = resolveExplicitHost(repository);

  if (explicit !== undefined) {
    return { ...explicit, source: 'explicit' };
  }

  if (!NAME_PATTERN.test(repository)) {
    return undefined;
  }

  // An empty string is how a caller reading a half-typed file says "nothing
  // declared"; it is not a registry named badly, so it falls back like the
  // absence it is.
  if (declaredRegistry === undefined || declaredRegistry === '') {
    return { host: DOCKER_HUB_HOST, name: repository, source: 'docker-hub-fallback' };
  }

  // A non-empty declared registry that is not a host is a malformed
  // reference, not an invitation to guess Hub instead: falling through would
  // answer a question about a registry nobody asked about.
  return HOST_PATTERN.test(declaredRegistry) ? { host: declaredRegistry, name: repository, source: 'declared' } : undefined;
}

export { resolveExplicitHost, resolveReference };
export type { RepositoryLocation, ResolvedReference };
