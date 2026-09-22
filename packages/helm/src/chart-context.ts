import { parseDocument } from 'yaml';
import type { ImageReference } from './extract-image-references';
import { readUsableScalar, type SourceRange } from './raw-scalar';

/** Reads a file's text, or `undefined` when nothing readable sits at that path. */
type ReadTextFile = (path: string) => Promise<string | undefined>;

/** The chart metadata governing a values file. */
interface ChartMetadata {
  /** Path of the metadata file itself, so a message can point the reader at it. */
  readonly path: string;
  /** `appVersion` exactly as written, or `undefined` when the chart declares none. */
  readonly appVersion: string | undefined;
}

/** A YAML file this package has something to say about, and the chart that governs it. */
interface ValuesFileContext {
  readonly chart: ChartMetadata | undefined;
}

/**
 * The tag a reference is checked against, and where it came from. The two
 * arms differ in what they can offer a message: a tag written in the file
 * has a range to underline, a tag taken from chart metadata has a file to
 * point the reader at instead.
 */
type ResolvedTag =
  | { readonly source: 'file'; readonly text: string; readonly range: SourceRange }
  | { readonly source: 'chart-metadata'; readonly text: string; readonly metadataPath: string };

/**
 * The names chart metadata goes by, in the order they are tried. Helm's own
 * convention is `Chart.yaml`, and `Chart.yml` turns up often enough that the
 * second spelling is a new row here rather than a new branch below.
 */
const CHART_METADATA_FILE_NAMES: readonly string[] = ['Chart.yaml', 'Chart.yml'];

/** The chart subdirectory holding Go templates, whose syntax yields nothing checkable. */
const TEMPLATES_DIRECTORY_NAME = 'templates';

/**
 * The names a values file goes by when no chart vouches for it — outside a
 * chart directory the name is the only evidence there is.
 */
const STANDALONE_VALUES_FILE_NAME = /^values\.ya?ml$/i;

/**
 * Resolves the chart governing a YAML file, and with it whether this package
 * has anything to say about that file at all.
 *
 * The nearest ancestor directory holding chart metadata wins, which is what
 * makes a subchart's values file resolve against the subchart's own
 * `appVersion` rather than its parent's — the subchart is what Helm would
 * actually deploy. Every YAML file beneath a chart directory is in scope,
 * not just the conventionally named ones, because environment overlays
 * rarely carry the name `values.yaml`.
 *
 * A file under the chart's `templates/` directory is out of scope outright,
 * even one named `values.yaml`. It is Go template source, and template
 * syntax resolves at render time, which this package never does.
 *
 * With no chart anywhere above it, a file is in scope only when its own name
 * says it is a values file — that keeps a standalone values file working
 * while leaving unrelated workspace YAML alone.
 *
 * Paths are split on `/` here rather than handed to `node:path`. Callers pass
 * a URI path, which is forward-slash separated on every platform, and
 * keeping platform path semantics out of this package keeps it a pure
 * source-text library.
 */
async function resolveValuesFileContext(path: string, readTextFile: ReadTextFile): Promise<ValuesFileContext | undefined> {
  const segments = path.split('/');

  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const chart = await readChartMetadata(segments.slice(0, depth), readTextFile);

    if (chart !== undefined) {
      const firstSegmentBelowChart = segments[depth];

      return firstSegmentBelowChart === TEMPLATES_DIRECTORY_NAME ? undefined : { chart };
    }
  }

  const fileName = segments[segments.length - 1];

  return fileName !== undefined && STANDALONE_VALUES_FILE_NAME.test(fileName) ? { chart: undefined } : undefined;
}

/**
 * Reads the chart metadata sitting directly in one directory, if any.
 *
 * The candidate path is assembled by joining segments rather than by
 * concatenating a directory and a name, so the filesystem root — whose
 * segments are a lone empty string — yields `/Chart.yaml` instead of
 * `//Chart.yaml`.
 */
async function readChartMetadata(directorySegments: readonly string[], readTextFile: ReadTextFile): Promise<ChartMetadata | undefined> {
  for (const fileName of CHART_METADATA_FILE_NAMES) {
    const metadataPath = [...directorySegments, fileName].join('/');
    const text = await readTextFile(metadataPath);

    if (text !== undefined) {
      return { path: metadataPath, appVersion: readAppVersion(text) };
    }
  }

  return undefined;
}

/**
 * Reads `appVersion` exactly as the chart wrote it. YAML coerces
 * `appVersion: 1.10` to the float `1.1`, so a parsed value would report a
 * version the chart never declared. An `appVersion` carrying Helm template
 * syntax is no more usable than an absent one, and reads as `undefined` too.
 */
function readAppVersion(source: string): string | undefined {
  // `getIn` hands back parsed values by default, and a parsed value is the
  // one thing this package never reads a field from.
  return readUsableScalar(source, parseDocument(source).getIn(['appVersion'], true))?.text;
}

/**
 * Resolves the tag a reference is checked against. A tag written in the file
 * wins; a tagless reference falls back to the governing chart's
 * `appVersion`, which is what Helm would render in its place. `undefined`
 * means the reference is checked against nothing at all and must produce no
 * marker.
 */
function resolveTag(reference: ImageReference, chart: ChartMetadata | undefined): ResolvedTag | undefined {
  if (reference.tag !== undefined) {
    return { source: 'file', text: reference.tag.text, range: reference.tag.range };
  }

  if (chart?.appVersion !== undefined) {
    return { source: 'chart-metadata', text: chart.appVersion, metadataPath: chart.path };
  }

  return undefined;
}

export { resolveTag, resolveValuesFileContext };
export type { ChartMetadata, ReadTextFile, ResolvedTag, ValuesFileContext };
