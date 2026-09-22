import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { ResolvedTag, SourceRange } from 'helm';
import type { ImageVerdict, UnverifiableReason } from 'oci-registry';
import { createFakeDocument } from '../test/fake-document';
import { hoverFor } from './hover';
import type { ReferenceCheck } from './reference-check';

const REPOSITORY = 'registry.example.com/svc';
const TAG = '1.0';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: "${TAG}"`, ''].join('\n');
const CHART_METADATA_PATH = '/repo/chart/Chart.yaml';
const PROVENANCE_SENTENCE = ' Tag taken from appVersion in chart/Chart.yaml.';

const VERIFIED_VERDICT: ImageVerdict = { kind: 'exists', registry: 'mirror.example.com' };

// The sentence each reason owes the reader, as a record so a new reason fails
// the build here instead of hovering with someone else's explanation.
const UNCHECKED_REASON_SENTENCES: Record<UnverifiableReason, string> = {
  'guessed-registry': 'nothing here names a registry, and Docker Hub — the only one left to try — does not have it.',
  'needs-login': 'no local Docker credential for that registry. Run `docker login` against it.',
  'authentication-failure': 'the registry refused the local Docker credential for it.',
  'network-error': 'the registry could not be reached.',
  'unexpected-response': 'the registry answered in a form this extension does not understand.',
  'malformed-reference': 'the reference is not a valid image reference.',
};

/** Stands in for `vscode.workspace.asRelativePath`, shortening enough that a hover can be seen to have used it. */
function describeChartPath(path: string): string {
  return path.replace('/repo/', '');
}

/** The unverifiable verdict a reason produces. Only `needs-login` carries a registry, so the shape cannot be built generically. */
function unverifiableVerdict(reason: UnverifiableReason): ImageVerdict {
  return reason === 'needs-login' ? { kind: 'unverifiable', reason, registry: 'registry.example.com' } : { kind: 'unverifiable', reason };
}

/** The source range of `text`'s first occurrence in {@link VALUES_YAML}. */
function rangeOfText(text: string): SourceRange {
  const start = VALUES_YAML.indexOf(text);

  return { start, end: start + text.length };
}

/** A check over the single reference in {@link VALUES_YAML}, carrying that file's real offsets. */
function createCheck(verdict: ImageVerdict, tag: ResolvedTag = { source: 'file', text: TAG, range: rangeOfText(TAG) }): ReferenceCheck {
  return {
    reference: {
      repository: { text: REPOSITORY, range: rangeOfText(REPOSITORY) },
      tag: tag.source === 'file' ? { text: tag.text, range: tag.range } : undefined,
      registry: undefined,
    },
    tag,
    verdict,
  };
}

/** The same reference written without a tag, checked against the chart's `appVersion` instead. */
function createChartMetadataCheck(verdict: ImageVerdict): ReferenceCheck {
  return createCheck(verdict, { source: 'chart-metadata', text: TAG, metadataPath: CHART_METADATA_PATH });
}

/** The hover at the first character of `text`'s occurrence in {@link VALUES_YAML}. */
function hoverAtText(document: vscode.TextDocument, checks: readonly ReferenceCheck[], text: string): vscode.Hover | undefined {
  return hoverFor(document, document.positionAt(VALUES_YAML.indexOf(text)), checks, describeChartPath);
}

/** The plain text of a hover's single content entry. */
function getHoverText(hover: vscode.Hover | undefined): string {
  const [content] = hover?.contents ?? [];

  if (content === undefined || typeof content === 'string') {
    throw new Error('expected a hover carrying one MarkdownString');
  }

  return content.value;
}

describe('hover', () => {
  it('should report the registry that answered for a verified reference', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const hoverText = getHoverText(hoverAtText(document, [createCheck(VERIFIED_VERDICT)], REPOSITORY));

    expect(hoverText).toContain('Verified');
    expect(hoverText).toContain('mirror.example.com');
  });

  it('should render its own sentence for every reason a reference went unverified', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    for (const [reason, sentence] of Object.entries(UNCHECKED_REASON_SENTENCES) as [UnverifiableReason, string][]) {
      const hoverText = getHoverText(hoverAtText(document, [createCheck(unverifiableVerdict(reason))], REPOSITORY));

      expect(hoverText).toBe(`Not verified: ${sentence}`);
    }
  });

  it('should name the chart a tag was taken from, on a verified reference and an unverified one alike', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const verified = createChartMetadataCheck(VERIFIED_VERDICT);
    const unverified = createChartMetadataCheck(unverifiableVerdict('network-error'));

    // A checkmark earned by a tag the file never wrote is worth attributing:
    // the hover is the only surface that can say where it came from.
    expect(getHoverText(hoverAtText(document, [verified], REPOSITORY))).toBe(`Verified on \`mirror.example.com\`.${PROVENANCE_SENTENCE}`);
    expect(getHoverText(hoverAtText(document, [unverified], REPOSITORY))).toBe(
      `Not verified: ${UNCHECKED_REASON_SENTENCES['network-error']}${PROVENANCE_SENTENCE}`
    );
  });

  it('should say nothing about a chart for a tag the file writes itself', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    expect(getHoverText(hoverAtText(document, [createCheck(VERIFIED_VERDICT)], REPOSITORY))).not.toContain('appVersion');
  });

  it('should provide no hover for a reference that does not exist, which already speaks through its diagnostic', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    expect(hoverAtText(document, [createCheck({ kind: 'repository-not-found', repository: REPOSITORY })], REPOSITORY)).toBeUndefined();
    expect(hoverAtText(document, [createCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: TAG })], TAG)).toBeUndefined();
  });

  it('should provide no hover outside any checked reference', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    expect(hoverAtText(document, [createCheck(VERIFIED_VERDICT)], 'image:')).toBeUndefined();
  });

  it('should resolve a position inside the tag to the same reference as one inside the repository', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const checks = [createCheck(VERIFIED_VERDICT)];

    expect(getHoverText(hoverAtText(document, checks, TAG))).toBe(getHoverText(hoverAtText(document, checks, REPOSITORY)));
  });
});
