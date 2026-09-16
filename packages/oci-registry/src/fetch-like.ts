/**
 * The slice of the WHATWG `Response` shape this package actually reads.
 * Deliberately narrow, and deliberately not the real `Response` type — that
 * would tie every caller and every test double to a global type this
 * workspace's `lib` doesn't even carry, for a package that only ever reads
 * four members off it.
 */
export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  /** Structurally satisfied by the platform's `Headers`. */
  readonly headers: { readonly get: (name: string) => string | null };
  readonly json: () => Promise<unknown>;
}

export interface FetchRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/**
 * The fetch implementation existence checking depends on, injected rather
 * than imported. Production wiring passes the platform's real `fetch`,
 * which satisfies this type structurally; tests pass a fake that asserts
 * the requests it received.
 */
export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;
