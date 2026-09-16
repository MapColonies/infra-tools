/**
 * The reason an image's existence could not be determined.
 *
 * Every reason resolves to the same {@link ImageVerdict} `'unverifiable'`
 * kind. That is the whole point of the shape: no caller can special-case a
 * *reason* into rendering a diagnostic, because only the verdict `kind`
 * controls that.
 */
type UnverifiableReason =
  /** The repository named no registry and the document declared none, so
   * Docker Hub was guessed — and the guess answered not-found. That is no
   * evidence the image is missing, only that this tool never knew where to
   * look. A bare internal service name absent from Hub is the ordinary case
   * in this organisation's charts, so reporting it as missing would be the
   * false negative this reason exists to prevent. */
  | 'guessed-registry'
  /** The registry is not one of the public ones, and no credential for it
   * could be resolved from the local Docker config. Distinct from
   * `'authentication-failure'` on purpose: this is the one reason a caller
   * can act on, by prompting for a `docker login`, and it is reached without
   * contacting the registry at all. */
  | 'needs-login'
  /** A credential existed and the registry rejected it. Nothing the user can
   * fix by logging in again in the general case — the token may be scoped
   * away from this repository — and, critically, not evidence the image is
   * missing: a registry is free to answer 401 rather than 404 for a
   * repository the caller may not know about. */
  | 'authentication-failure'
  /** The request itself failed — DNS, connection refused, timeout, and so on. */
  | 'network-error'
  /** The registry responded, but not in a way this checker understands. */
  | 'unexpected-response'
  /** Some part of the reference is outside the grammar it has to satisfy: the
   * tag, the repository name, or a registry the document declared. Rejected
   * before any request is issued — building a manifest URL out of an
   * unvalidated reference is how a crafted values file smuggles a path
   * traversal, or a different host, into the request. */
  | 'malformed-reference';

/**
 * An unverifiable verdict, split so that only `'needs-login'` carries the
 * registry it applies to.
 *
 * The host rides on that arm specifically rather than on the whole kind: a
 * "log in to X" prompt is unbuildable without a host, so the type refuses to
 * let a caller reach that reason without one, and no other reason can
 * pretend to have a host it never established.
 */
type UnverifiableVerdict =
  | { readonly kind: 'unverifiable'; readonly reason: 'needs-login'; readonly registry: string }
  | { readonly kind: 'unverifiable'; readonly reason: Exclude<UnverifiableReason, 'needs-login'> };

/**
 * The outcome of checking whether an image reference exists.
 *
 * Modelled as four explicit outcomes rather than a boolean plus an error,
 * because the two failure modes are not interchangeable: `'unverifiable'`
 * must never be treated as evidence the image is missing. That invariant —
 * an unverifiable verdict produces no diagnostic — is the reason this type
 * exists in this shape rather than a simpler one, and it is what the
 * `'guessed-registry'` downgrade relies on: a not-found this package does
 * not trust is moved into the kind that says nothing, which is only a safe
 * move because that kind is guaranteed to stay silent.
 */
type ImageVerdict =
  | { readonly kind: 'exists'; readonly registry: string }
  | { readonly kind: 'repository-not-found'; readonly repository: string }
  | { readonly kind: 'tag-not-found'; readonly repository: string; readonly tag: string }
  | UnverifiableVerdict;

export type { ImageVerdict, UnverifiableReason };
