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
 * A candidate image reference found in a Helm values file.
 *
 * `repository` carries the scalar's raw source text and its range, not the
 * value YAML parsed it into — see {@link extractImageReferences}. `tag` is
 * `undefined` when the mapping carries no `tag` key at all: a tagless
 * reference is reported as such rather than dropped, because resolving it
 * through the governing chart's `appVersion` is a later ticket's job, not
 * this function's.
 */
interface ImageReference {
  readonly repository: RawScalar;
  readonly tag: RawScalar | undefined;
}

/**
 * A sibling key that, alongside `repository`, is enough to treat a mapping
 * as an image reference rather than incidental configuration — a
 * source-control URL under a `repository` key, for example, carries none of
 * these.
 */
const CORROBORATING_SIBLING_KEYS: ReadonlySet<string> = new Set(['tag', 'pullPolicy', 'registry']);

/** The exact parent key that corroborates a `repository` mapping on its own. */
const CORROBORATING_PARENT_KEY = 'image';

/**
 * Finds image references in Helm values file source text.
 *
 * Detection is structural rather than path-based, so a chart does not have
 * to place its images at conventional locations for this to find them: a
 * candidate is any YAML mapping, at any depth, carrying a `repository` key.
 *
 * A `repository` key alone over-matches — a source-control URL under a
 * `repository` key would qualify — so a candidate must also carry a
 * corroborating signal: a sibling `tag`, `pullPolicy` or `registry` key, or
 * a parent key of `image` or one ending in `Image`. A `tag` sibling is
 * optional rather than required for this signal, and optional for the
 * reference itself: a mapping with no `tag` key still produces a reference,
 * with `tag: undefined`, because resolving a tagless image through the
 * chart's `appVersion` is a later ticket's job.
 *
 * `repository` and `tag` are read from the raw source text of their scalar
 * nodes, never from the value YAML parsed them into: YAML coerces `1.10` to
 * the float `1.1` and `12` to an integer, so reading the parsed value would
 * put a confident, wrong diagnostic on a correct file. Reading source text
 * requires node ranges, which is the same information diagnostics need to
 * know where to point.
 *
 * A value whose raw text contains Helm template syntax is unresolvable
 * without rendering the chart, so it is skipped silently: a templated
 * `repository` drops the whole candidate, and a templated `tag` is treated
 * the same as an absent one.
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

/**
 * Whether a mapping's enclosing key corroborates it as an image reference —
 * the mapping is the value of a `Pair` keyed `image`, or a key ending in
 * `Image` (`sidecarImage`, `initContainerImage`, and so on).
 */
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

  // A key with nothing after the colon (`repository:`) parses as a
  // zero-length scalar, not as `null` or an absent pair — an explicit
  // `null` has source text `"null"` and a non-empty range. Treating the
  // zero-length case as a value would produce a reference with an
  // empty-string repository, or a "tagless" reference reported as tagged
  // with an empty tag.
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
