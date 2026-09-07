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
export interface RepositoryLocation {
  readonly host: string;
  readonly name: string;
}

/**
 * Detects an explicit registry host named in a repository string, using the
 * standard OCI/Docker rule: the first `/`-separated segment counts as a
 * host when it contains a dot or a colon, or is exactly `localhost`.
 *
 * Reference normalization is OCI naming semantics, not anything Helm- or
 * editor-specific, which is why it lives here rather than in the package
 * that extracted the raw string. This is also the only registry-resolution
 * step this package implements today: a registry declared elsewhere in the
 * same YAML document, a workspace override set, and the Docker Hub fallback
 * are later tickets. Returning `undefined` when no explicit host is found
 * — rather than guessing one — is what lets the caller treat "not fully
 * qualified" as unverifiable instead of inventing a wrong answer.
 */
export function resolveExplicitHost(repository: string): RepositoryLocation | undefined {
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
