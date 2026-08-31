/**
 * The reason an image's existence could not be determined.
 *
 * This list is expected to grow — credential handling, the document/registry
 * fallback chain, and the Docker Hub guess-downgrade rule from spec #17 each
 * add reasons of their own — but every reason, present or future, resolves
 * to the same {@link ImageVerdict} `'unverifiable'` kind. That is the whole
 * point of the shape: no caller can special-case a *reason* into rendering a
 * diagnostic, because only the verdict `kind` controls that.
 */
export type UnverifiableReason =
  /** The repository names no explicit registry host, and this package does
   * not yet resolve one any other way (a document-declared registry, a
   * workspace override set, or the Docker Hub fallback). */
  | 'no-registry'
  /** The registry demanded authentication this package cannot yet provide. */
  | 'missing-credential'
  /** The request itself failed — DNS, connection refused, timeout, and so on. */
  | 'network-error'
  /** The registry responded, but not in a way this checker understands. */
  | 'unexpected-response';

/**
 * The outcome of checking whether an image reference exists.
 *
 * Modelled as four explicit outcomes rather than a boolean plus an error,
 * because the two failure modes are not interchangeable: `'unverifiable'`
 * must never be treated as evidence the image is missing. That invariant —
 * an unverifiable verdict produces no diagnostic — is the reason this type
 * exists in this shape rather than a simpler one.
 */
export type ImageVerdict =
  | { readonly kind: 'exists'; readonly registry: string }
  | { readonly kind: 'repository-not-found'; readonly repository: string }
  | { readonly kind: 'tag-not-found'; readonly repository: string; readonly tag: string }
  | { readonly kind: 'unverifiable'; readonly reason: UnverifiableReason };
