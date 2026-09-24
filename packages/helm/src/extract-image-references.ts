import { isPair, isScalar, parseDocument, visit, type Document, type Pair } from 'yaml';
import { readUsableScalar, type RawScalar } from './raw-scalar';

/**
 * A candidate image reference found in a Helm values file. `tag` is
 * `undefined` for a tagless reference, which `resolveTag` resolves through
 * the governing chart's `appVersion`.
 */
interface ImageReference {
  readonly repository: RawScalar;
  readonly tag: RawScalar | undefined;
  /**
   * The registry declared for this reference, as written, or `undefined`
   * when the document declares none. A bare string rather than a
   * {@link RawScalar}: a document-level declaration sits on a line that has
   * nothing to do with this reference, so a range here would underline
   * somewhere misleading.
   */
  readonly registry: string | undefined;
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
        registry: readSiblingScalar(source, node.items, 'registry')?.text ?? documentRegistry,
      });
    },
  });

  return references;
}

/**
 * Reads the registry the document declares for all of its references, trying
 * each known key path in precedence order.
 */
function readDocumentRegistry(source: string, document: Document): string | undefined {
  for (const path of DOCUMENT_REGISTRY_KEY_PATHS) {
    // `getIn` hands back parsed values by default, and a parsed value is the
    // one thing this package never reads a field from.
    const registry = readUsableScalar(source, document.getIn(path, true));

    if (registry !== undefined) {
      return registry.text;
    }
  }

  return undefined;
}

/** Reads a named key's value from the mapping a candidate was found in. */
function readSiblingScalar(source: string, items: readonly Pair[], name: string): RawScalar | undefined {
  const pair = items.find((candidate) => keyNameOf(candidate) === name);

  return pair === undefined ? undefined : readUsableScalar(source, pair.value);
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

export { extractImageReferences };
export type { ImageReference };
