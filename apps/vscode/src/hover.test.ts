import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { SourceRange } from 'helm';
import { createFakeDocument } from '../test/fake-document';
import { hoverFor } from './hover';
import type { ReferenceCheck, ReferenceVerdict, UncheckedReason } from './reference-check';

const REPOSITORY = 'registry.example.com/svc';
const TAG = '1.0';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: "${TAG}"`, ''].join('\n');

const VERIFIED_VERDICT: ReferenceVerdict = { kind: 'exists', registry: 'mirror.example.com' };

// The sentence each reason owes the reader, as a record so a new reason fails
// the build here instead of hovering with someone else's explanation.
const UNCHECKED_REASON_SENTENCES: Record<UncheckedReason, string> = {
  'no-tag': 'the reference names no tag to check.',
  'guessed-registry': 'nothing here names a registry, and Docker Hub — the only one left to try — does not have it.',
  'needs-login': 'no local Docker credential for that registry. Run `docker login` against it.',
  'authentication-failure': 'the registry refused the local Docker credential for it.',
  'network-error': 'the registry could not be reached.',
  'unexpected-response': 'the registry answered in a form this extension does not understand.',
  'malformed-reference': 'the reference is not a valid image reference.',
};

/** The unverifiable verdict a reason produces. Only `needs-login` carries a registry, so the shape cannot be built generically. */
function unverifiableVerdict(reason: UncheckedReason): ReferenceVerdict {
  return reason === 'needs-login' ? { kind: 'unverifiable', reason, registry: 'registry.example.com' } : { kind: 'unverifiable', reason };
}

/** The source range of `text`'s first occurrence in {@link VALUES_YAML}. */
function rangeOfText(text: string): SourceRange {
  const start = VALUES_YAML.indexOf(text);

  return { start, end: start + text.length };
}

/** A check over the single reference in {@link VALUES_YAML}, carrying that file's real offsets. */
function createCheck(verdict: ReferenceVerdict): ReferenceCheck {
  return {
    reference: {
      repository: { text: REPOSITORY, range: rangeOfText(REPOSITORY) },
      tag: { text: TAG, range: rangeOfText(TAG) },
      registry: undefined,
    },
    verdict,
  };
}

/** A check over the same reference written without a tag, which is what a `no-tag` verdict comes from. */
function createTaglessCheck(verdict: ReferenceVerdict): ReferenceCheck {
  return {
    reference: {
      repository: { text: REPOSITORY, range: rangeOfText(REPOSITORY) },
      tag: undefined,
      registry: undefined,
    },
    verdict,
  };
}

/** The hover at the first character of `text`'s occurrence in {@link VALUES_YAML}. */
function hoverAtText(document: vscode.TextDocument, checks: readonly ReferenceCheck[], text: string): vscode.Hover | undefined {
  return hoverFor(document, document.positionAt(VALUES_YAML.indexOf(text)), checks);
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

    for (const [reason, sentence] of Object.entries(UNCHECKED_REASON_SENTENCES) as [UncheckedReason, string][]) {
      const hoverText = getHoverText(hoverAtText(document, [createCheck(unverifiableVerdict(reason))], REPOSITORY));

      expect(hoverText).toBe(`Not verified: ${sentence}`);
    }
  });

  it('should explain a tagless reference, which carries no tag to hover in the first place', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const check = createTaglessCheck({ kind: 'unverifiable', reason: 'no-tag' });

    expect(getHoverText(hoverAtText(document, [check], REPOSITORY))).toContain('no tag');
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
