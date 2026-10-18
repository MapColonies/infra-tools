import type * as vscode from 'vscode';
import type { CheckImageExistenceParams, ImageVerdict } from 'oci-registry';

// In extension state rather than in memory, so a window reload does not
// cost every image in the workspace a fresh request.
const VERDICT_CACHE_KEY = 'infraTools.verdictCache';

const EXISTS_LIFETIME_MS = 86_400_000; // a day
const NOT_FOUND_LIFETIME_MS = 60_000; // a minute
const UNVERIFIABLE_LIFETIME_MS = 30_000; // tens of seconds

/**
 * How long each kind of verdict is trusted, and deliberately lopsided. A tag
 * that resolved once is effectively immutable, so a day costs nothing in
 * correctness and turns a green workspace into about one request per image
 * per day — which is what Docker Hub's per-IP pull limit can afford. A
 * not-found is very likely a tag the developer is about to push, so it must
 * not keep the line red for long. An unverifiable is a fact about the
 * network or this machine right now, and shorter-lived still.
 */
function lifetimeOf(verdict: ImageVerdict): number {
  switch (verdict.kind) {
    case 'exists':
      return EXISTS_LIFETIME_MS;
    case 'repository-not-found':
    case 'tag-not-found':
      return NOT_FOUND_LIFETIME_MS;
    case 'unverifiable':
      return UNVERIFIABLE_LIFETIME_MS;
  }
}

/** Everything a verdict depends on, short of the credentials asked with. */
type VerdictQuery = Pick<CheckImageExistenceParams, 'repository' | 'tag' | 'declaredRegistry' | 'overrideRegistries'>;

interface CacheEntry {
  readonly verdict: ImageVerdict;
  readonly expiresAt: number;
  /**
   * Every chart whose `appVersion` supplied this tag to a check the entry
   * answered. A set rather than one owner, because one image and tag is
   * asked about by several charts, and by files that write the tag out.
   */
  readonly chartMetadataPaths: readonly string[];
}

/** A registry request already under way, and the charts waiting on it. */
interface PendingVerdict {
  readonly verdict: Promise<ImageVerdict>;
  readonly chartMetadataPaths: Set<string>;
}

interface VerdictCache {
  /**
   * The verdict for `query`: a fresh cached one, else the answer to a
   * request already under way for it, else what `ask` answers, which is
   * then cached. `chartMetadataPath` names the chart whose `appVersion`
   * supplied the tag, if one did, so a bump there can evict the answer
   * however it was reached.
   */
  readonly verdictFor: (query: VerdictQuery, chartMetadataPath: string | undefined, ask: () => Promise<ImageVerdict>) => Promise<ImageVerdict>;
  /**
   * Drops every verdict about a tag taken from this chart's `appVersion`. A
   * bump changes which tag is asked about, and a day-long answer about one
   * the developer is moving between must not stand in for asking again.
   */
  readonly evictChart: (chartMetadataPath: string) => void;
}

/**
 * The key a query is stored under. Every field the verdict depends on is in
 * it, override set included, so changing the set reads as a different
 * question rather than one already answered.
 */
function keyOf({ repository, tag, declaredRegistry, overrideRegistries }: VerdictQuery): string {
  return JSON.stringify([repository, tag, declaredRegistry ?? null, overrideRegistries]);
}

// The kinds this build can render. A stored verdict of any other kind came
// from a different build, and every surface switches exhaustively on kind.
const VERDICT_KINDS: ReadonlySet<string> = new Set<ImageVerdict['kind']>(['exists', 'repository-not-found', 'tag-not-found', 'unverifiable']);

/**
 * The entries a previous session left in extension state. Read defensively,
 * because the stored shape is whatever an older build of this extension
 * wrote: an entry this build cannot read is dropped and asked again, which
 * costs one request, where trusting it could cost a wrong mark.
 */
function readStoredEntries(state: vscode.Memento): Map<string, CacheEntry> {
  const stored = state.get<unknown>(VERDICT_CACHE_KEY);

  if (typeof stored !== 'object' || stored === null) {
    return new Map();
  }

  return new Map(
    Object.entries(stored).filter((pair): pair is [string, CacheEntry] => {
      const entry: unknown = pair[1];

      return (
        typeof entry === 'object' &&
        entry !== null &&
        'expiresAt' in entry &&
        typeof entry.expiresAt === 'number' &&
        'verdict' in entry &&
        typeof entry.verdict === 'object' &&
        entry.verdict !== null &&
        'kind' in entry.verdict &&
        typeof entry.verdict.kind === 'string' &&
        VERDICT_KINDS.has(entry.verdict.kind) &&
        'chartMetadataPaths' in entry &&
        Array.isArray(entry.chartMetadataPaths) &&
        entry.chartMetadataPaths.every((path) => typeof path === 'string')
      );
    })
  );
}

/**
 * Registry verdicts already answered, persisted in extension state so they
 * outlive a window reload, each trusted for as long as its kind allows.
 */
function createVerdictCache(state: vscode.Memento, now: () => number): VerdictCache {
  const entries = readStoredEntries(state);
  const pendingVerdicts = new Map<string, PendingVerdict>();

  function persist(): void {
    // Expired entries are dropped on the way out rather than read around
    // forever, so extension state holds only what could still be served.
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now()) {
        entries.delete(key);
      }
    }

    // Not awaited, since a check should not wait on disk, and its rejection
    // swallowed: this runs inside open and watcher listeners, where anything
    // escaping takes the extension host down. A write that fails costs only
    // the requests a reload would otherwise have been spared.
    state.update(VERDICT_CACHE_KEY, Object.fromEntries(entries)).then(undefined, () => undefined);
  }

  function freshEntry(key: string): CacheEntry | undefined {
    const entry = entries.get(key);

    return entry !== undefined && entry.expiresAt > now() ? entry : undefined;
  }

  async function ask(key: string, chartMetadataPath: string | undefined, request: () => Promise<ImageVerdict>): Promise<ImageVerdict> {
    const pending: PendingVerdict = { verdict: request(), chartMetadataPaths: new Set(chartMetadataPath === undefined ? [] : [chartMetadataPath]) };
    pendingVerdicts.set(key, pending);

    try {
      const verdict = await pending.verdict;

      // An eviction while this was in flight withdrew it, and its answer is
      // about a chart state that has since changed, so it is not kept.
      if (pendingVerdicts.get(key) === pending) {
        entries.set(key, { verdict, expiresAt: now() + lifetimeOf(verdict), chartMetadataPaths: [...pending.chartMetadataPaths] });
        persist();
      }

      return verdict;
    } finally {
      if (pendingVerdicts.get(key) === pending) {
        pendingVerdicts.delete(key);
      }
    }
  }

  return {
    verdictFor: async (query, chartMetadataPath, request): Promise<ImageVerdict> => {
      const key = keyOf(query);
      const cached = freshEntry(key);

      if (cached !== undefined) {
        if (chartMetadataPath !== undefined && !cached.chartMetadataPaths.includes(chartMetadataPath)) {
          entries.set(key, { ...cached, chartMetadataPaths: [...cached.chartMetadataPaths, chartMetadataPath] });
          persist();
        }

        return cached.verdict;
      }

      // Two references to one image in a file, or two files opening
      // together, share one request rather than racing each other to it.
      const pending = pendingVerdicts.get(key);

      if (pending !== undefined) {
        if (chartMetadataPath !== undefined) {
          pending.chartMetadataPaths.add(chartMetadataPath);
        }

        return pending.verdict;
      }

      return ask(key, chartMetadataPath, request);
    },
    evictChart: (chartMetadataPath): void => {
      for (const [key, entry] of entries) {
        if (entry.chartMetadataPaths.includes(chartMetadataPath)) {
          entries.delete(key);
        }
      }

      for (const [key, pending] of pendingVerdicts) {
        if (pending.chartMetadataPaths.has(chartMetadataPath)) {
          pendingVerdicts.delete(key);
        }
      }

      persist();
    },
  };
}

export { createVerdictCache };
export type { VerdictCache };
