/**
 * Readers for values this package parses but does not control: a
 * `config.json` on the developer's machine, and a token endpoint's response
 * body.
 *
 * Neither is guaranteed to be the shape it should be, and neither is worth
 * an exception when it isn't — a stray comma in a Docker config is not a
 * defect in the chart being checked. So every field comes back `undefined`
 * rather than throwing, and the caller decides what an absent field means.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The named field of `source`, when `source` is an object and the field holds a string. */
function readStringField(source: unknown, field: string): string | undefined {
  if (!isRecord(source)) {
    return undefined;
  }

  const value = source[field];

  return typeof value === 'string' ? value : undefined;
}

export { isRecord, readStringField };
