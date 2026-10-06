import type { FetchLike } from 'oci-registry';

/**
 * Wraps `fetch` so no more than `limit` requests are in flight at once; the
 * rest wait their turn in the order they were made.
 *
 * A request's slot is freed once its response arrives, not once its body is
 * read. That is also what keeps the token exchange from deadlocking: a check
 * that needs a bearer token holds no slot while it asks for one.
 */
function limitConcurrency(fetch: FetchLike, limit: number): FetchLike {
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  async function acquire(): Promise<void> {
    if (inFlight < limit) {
      inFlight += 1;
      return;
    }

    // The slot is handed over directly by `release`, so `inFlight` never
    // dips below the limit while anything is still waiting.
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
    });
  }

  function release(): void {
    const next = waiting.shift();

    if (next === undefined) {
      inFlight -= 1;
      return;
    }

    next();
  }

  return async (url, init) => {
    await acquire();

    try {
      return await fetch(url, init);
    } finally {
      release();
    }
  };
}

export { limitConcurrency };
