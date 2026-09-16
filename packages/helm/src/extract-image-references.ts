import { isPair, isScalar, parseDocument, visit, type Document, type Pair } from 'yaml';

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
  /** The registry declared for this reference, if the document declares one. */
  readonly registry: RawScalar | undefined;
}

/** A sibling key that corroborates `repository` as an image reference. */
const CORROBORATING_SIBLING_KEYS: ReadonlySet<string> = new Set(['tag', 'pullPolicy', 'registry']);

/** The exact parent key that corroborates a `repository` mapping on its own. */
const CORROBORATING_PARENT_KEY = 'image';

/**
 * The key paths under which a values file declares one registry for the whole
 * document. Listed in precedence order: the first path holding a usable
 * scalar wins, so a new convention is a new row rather than a new branch.
 */
const DOCUMENT_REGISTRY_KEY_PATHS: readonly (readonly string[])[] = [
  ['global', 'imageRegistry'],
  ['global', 'registry'],
  ['imageRegistry'],
  ['registry'],
];

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
 * Values files commonly split the registry off from the repository, so
 * `repository: my-service` under a declared `myreg.example.com` names
 * `myreg.example.com/my-service`. A sibling `registry` key wins; otherwise
 * the document-level registry found through `DOCUMENT_REGISTRY_KEY_PATHS`
 * applies to every reference in the file. The declared string is emitted as
 * written — deciding what it points at belongs to the OCI registry package.
 *
 * Every field is read from raw source text, not the parsed value: YAML
 * coerces `1.10` to the float `1.1`, which would put a wrong diagnostic on a
 * correct file.
 *
 * A value containing Helm template syntax is unusable, and so is a non-scalar
 * or empty one. An unusable `repository` drops the candidate; an unusable
 * `tag` makes the reference tagless; an unusable `registry` falls through to
 * the next candidate in the order above.
 */
function extractImageReferences(source: string): ImageReference[] {
  const document = parseDocument(source);
  const documentRegistry = readDocumentRegistry(source, document);
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

      const repository = readUsableScalar(source, repositoryPair.value);

      if (repository === undefined) {
        return;
      }

      references.push({
        repository,
        tag: readSiblingScalar(source, node.items, 'tag'),
        registry: readSiblingScalar(source, node.items, 'registry') ?? documentRegistry,
      });
    },
  });

  return references;
}

/**
 * Reads the registry the document declares for all of its references, trying
 * each known key path in precedence order.
 */
function readDocumentRegistry(source: string, document: Document): RawScalar | undefined {
  for (const path of DOCUMENT_REGISTRY_KEY_PATHS) {
    // `getIn` hands back parsed values by default; the scalar node is what
    // carries the source range.
    const registry = readUsableScalar(source, document.getIn(path, true));

    if (registry !== undefined) {
      return registry;
    }
  }

  return undefined;
}

/** Reads a named key's value from the mapping a candidate was found in. */
function readSiblingScalar(source: string, items: readonly Pair[], name: string): RawScalar | undefined {
  const pair = items.find((candidate) => keyNameOf(candidate) === name);

  return pair === undefined ? undefined : readUsableScalar(source, pair.value);
}

/**
 * Reads a scalar a consumer can act on. Helm resolves template syntax at
 * render time, and this package never renders, so a templated value is no
 * more usable here than a missing one and reads as `undefined` too.
 */
function readUsableScalar(source: string, node: unknown): RawScalar | undefined {
  const scalar = readRawScalar(source, node);

  return scalar === undefined || containsHelmTemplateSyntax(scalar.text) ? undefined : scalar;
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
