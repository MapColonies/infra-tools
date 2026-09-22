import type { ResolvedTag } from 'helm';

/**
 * The sentence a message owes the reader when the tag it reports was never
 * written in the file.
 *
 * Shared by the diagnostic and the hover so the two cannot word the same
 * provenance differently, and empty for a tag the file wrote, which needs no
 * explaining. `describeChartPath` shortens the path for display: an absolute
 * path in the Problems panel is noise the reader has to scan past.
 */
function chartProvenanceSentence(tag: ResolvedTag, describeChartPath: (path: string) => string): string {
  return tag.source === 'file' ? '' : ` Tag taken from appVersion in ${describeChartPath(tag.metadataPath)}.`;
}

export { chartProvenanceSentence };
