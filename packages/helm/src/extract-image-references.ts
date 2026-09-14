import { isPair, isScalar, parseDocument, visit, type Pair } from 'yaml';

/** A half-open character range into the original source text. */
interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** A scalar's exact source text, never the value YAML parsed it into. */
interface RawScalar {
  readonly text: string;
  readonly range: SourceRange;
}

/**
 * A candidate image reference found in a Helm values file. `tag` is
 * `undefined` for a tagless reference — resolving it via `appVersion` is a
 * later ticket's job.
 */
interface ImageReference {
  readonly repository: RawScalar;
  readonly tag: RawScalar | undefined;
}

/** A sibling key that corroborates `repository` as an image reference. */
const CORROBORATING_SIBLING_KEYS: ReadonlySet<string> = new Set(['tag', 'pullPolicy', 'registry']);

/** The exact parent key that corroborates a `repository` mapping on its own. */
const CORROBORATING_PARENT_KEY = 'image';

/**
 * Finds image references in Helm values file source text.
 *
 * Detection is structural: any mapping, at any depth, carrying a
 * `repository` key is a candidate. `repository` alone over-matches (e.g. a
 * source-control URL), so a candidate also needs a corroborating signal — a
 * sibling `tag`/`pullPolicy`/`registry` key, or a parent key of `image` or
 * ending in `Image`. A missing `tag` doesn't disqualify a candidate; it
 * makes the reference tagless.
 *
 * `repository` and `tag` are read from raw source text, not the parsed
 * value: YAML coerces `1.10` to the float `1.1`, which would put a wrong
 * diagnostic on a correct file.
 *
 * A value containing Helm template syntax is skipped: a templated
 * `repository` drops the candidate, a templated `tag` is treated as absent.
 */
function extractImageReferences(source: string): ImageReference[] {
  const document = parseDocument(source);
  const references: ImageReference[] = [];

  visit(document, {
    // `Map` is the yaml package's own visitor method name, not a naming
    // choice made here — it dispatches by AST node kind.
    // eslint-disable-next-line @typescript-eslint/naming-convention -- required by the `yaml` package's visitor contract
    Map(_key, node, path) {
      const repositoryPair = node.items.find((pair) => keyNameOf(pair) === 'repository');

      if (repositoryPair === undefined) {
        return;
      }

      const hasCorroboratingSignal =
        node.items.some((pair) => {
          const name = keyNameOf(pair);
          return name !== undefined && CORROBORATING_SIBLING_KEYS.has(name);
        }) || hasCorroboratingParentKey(path);

      if (!hasCorroboratingSignal) {
        return;
      }

      const repository = readRawScalar(source, repositoryPair.value);

      if (repository === undefined || containsHelmTemplateSyntax(repository.text)) {
        return;
      }

      const tagPair = node.items.find((pair) => keyNameOf(pair) === 'tag');
      const tag = tagPair === undefined ? undefined : readRawScalar(source, tagPair.value);

      references.push({
        repository,
        tag: tag === undefined || containsHelmTemplateSyntax(tag.text) ? undefined : tag,
      });
    },
  });

  return references;
}

/** Whether a mapping's parent key is `image` or ends in `Image`. */
function hasCorroboratingParentKey(path: readonly unknown[]): boolean {
  const parent = path[path.length - 1];
  const parentKey = isPair(parent) ? keyNameOf(parent) : undefined;

  return parentKey !== undefined && (parentKey === CORROBORATING_PARENT_KEY || parentKey.endsWith('Image'));
}

/** A pair's key name, or `undefined` when the key isn't a plain scalar. */
function keyNameOf(pair: Pair): string | undefined {
  return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

/** Whether a scalar's raw text contains unresolved Helm template syntax. */
function containsHelmTemplateSyntax(text: string): boolean {
  return text.includes('{{') && text.includes('}}');
}

/**
 * Slices a scalar node's exact source text out of the document, stripping a
 * single layer of matching quotes when the scalar was written quoted. Only
 * plain and single/double-quoted scalars carry a usable range here; a
 * missing value, or a non-scalar value (a nested mapping or sequence),
 * yields `undefined` so the caller skips the candidate entirely.
 */
function readRawScalar(source: string, node: unknown): RawScalar | undefined {
  if (!isScalar(node)) {
    return undefined;
  }

  const range = node.range;

  if (!range) {
    return undefined;
  }

  const [start, end] = range;

  // Nothing after the colon (`repository:`) parses as a zero-length scalar,
  // not `null` — treat it as absent rather than an empty-string value.
  if (start === end) {
    return undefined;
  }

  const raw = source.slice(start, end);
  const { text, offset } = stripQuotes(raw);

  return {
    text,
    range: { start: start + offset, end: start + offset + text.length },
  };
}

// A quote pair is the shortest string that can carry one: two characters,
// one at each end.
const MIN_QUOTED_LENGTH = 2;

/** Strips one layer of matching single or double quotes, if present. */
function stripQuotes(raw: string): { text: string; offset: number } {
  const first = raw[0];
  const last = raw[raw.length - 1];

  if (raw.length >= MIN_QUOTED_LENGTH && first === last && (first === '"' || first === "'")) {
    return { text: raw.slice(1, raw.length - 1), offset: 1 };
  }

  return { text: raw, offset: 0 };
}

export { extractImageReferences };
export type { ImageReference, RawScalar, SourceRange };
