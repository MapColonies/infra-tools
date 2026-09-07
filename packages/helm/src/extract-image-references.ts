import { isScalar, parseDocument, visit } from 'yaml';

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
 * A candidate `repository`/`tag` pair found in a Helm values file.
 *
 * Both fields carry the scalar's raw source text and its range, not the
 * value YAML parsed it into — see {@link extractImageReferences}.
 */
interface ImageReference {
  readonly repository: RawScalar;
  readonly tag: RawScalar;
}

/**
 * Finds image references in Helm values file source text.
 *
 * Detection is deliberately narrow, matching only the conventional path: a
 * candidate is a YAML mapping that carries both a `repository` key and a
 * `tag` key as direct siblings, with both values as plain scalars (not
 * nested mappings or sequences). Generalising detection to corroborating
 * signals other than a sibling `tag` — a sibling `pullPolicy`/`registry`,
 * or a parent key of `image` or one ending in `Image` — is deliberately
 * deferred to a later ticket, as is resolving a tagless image through a
 * chart's `appVersion`.
 *
 * `repository` and `tag` are read from the raw source text of their scalar
 * nodes, never from the value YAML parsed them into: YAML coerces `1.10` to
 * the float `1.1` and `12` to an integer, so reading the parsed value would
 * put a confident, wrong diagnostic on a correct file. Reading source text
 * requires node ranges, which is the same information diagnostics need to
 * know where to point.
 */
function extractImageReferences(source: string): ImageReference[] {
  const document = parseDocument(source);
  const references: ImageReference[] = [];

  visit(document, {
    // `Map` is the yaml package's own visitor method name, not a naming
    // choice made here — it dispatches by AST node kind.
    // eslint-disable-next-line @typescript-eslint/naming-convention -- required by the `yaml` package's visitor contract
    Map(_key, node) {
      const repositoryPair = node.items.find((pair) => isScalar(pair.key) && pair.key.value === 'repository');
      const tagPair = node.items.find((pair) => isScalar(pair.key) && pair.key.value === 'tag');

      if (repositoryPair === undefined || tagPair === undefined) {
        return;
      }

      const repository = readRawScalar(source, repositoryPair.value);
      const tag = readRawScalar(source, tagPair.value);

      if (repository === undefined || tag === undefined) {
        return;
      }

      references.push({ repository, tag });
    },
  });

  return references;
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
