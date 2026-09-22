import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { ResolvedTag, SourceRange } from 'helm';
import type { ImageVerdict, UnverifiableReason } from 'oci-registry';
import { createFakeDocument } from '../test/fake-document';
import { diagnosticsFor } from './diagnostics';
import type { ReferenceCheck } from './reference-check';

const REPOSITORY = 'registry.example.com/svc';
const TAG = '1.0';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: "${TAG}"`, ''].join('\n');
const CHART_METADATA_PATH = '/repo/chart/Chart.yaml';

// A record rather than a list, so a new reason fails the build here instead
// of going untested.
const UNCHECKED_VERDICTS: Record<UnverifiableReason, ImageVerdict> = {
  'guessed-registry': { kind: 'unverifiable', reason: 'guessed-registry' },
  'needs-login': { kind: 'unverifiable', reason: 'needs-login', registry: REPOSITORY },
  'authentication-failure': { kind: 'unverifiable', reason: 'authentication-failure' },
  'network-error': { kind: 'unverifiable', reason: 'network-error' },
  'unexpected-response': { kind: 'unverifiable', reason: 'unexpected-response' },
  'malformed-reference': { kind: 'unverifiable', reason: 'malformed-reference' },
};

/** Stands in for `vscode.workspace.asRelativePath`, shortening enough that a message can be seen to have used it. */
function describeChartPath(path: string): string {
  return path.replace('/repo/', '');
}

/** The source range of `text`'s first occurrence in {@link VALUES_YAML}. */
function rangeOfText(text: string): SourceRange {
  const start = VALUES_YAML.indexOf(text);

  return { start, end: start + text.length };
}

/** The document range covering `text`'s first occurrence in {@link VALUES_YAML}. */
function documentRangeOfText(document: vscode.TextDocument, text: string): vscode.Range {
  const { start, end } = rangeOfText(text);

  return new vscode.Range(document.positionAt(start), document.positionAt(end));
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

describe('diagnostics', () => {
  it('should report an error naming the missing repository, positioned on the repository value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createCheck({ kind: 'repository-not-found', repository: REPOSITORY })], describeChartPath);

    expect(fileDiagnostics).toHaveLength(1);
    expect(fileDiagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(fileDiagnostics[0]?.message).toContain(REPOSITORY);
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, REPOSITORY));
  });

  it('should report an error naming the missing tag, positioned on the tag value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: TAG })], describeChartPath);

    expect(fileDiagnostics).toHaveLength(1);
    expect(fileDiagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(fileDiagnostics[0]?.message).toBe(`Tag '${TAG}' not found in '${REPOSITORY}'.`);
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, TAG));
  });

  it('should attach a tag taken from chart metadata to the repository value, and name the chart it came from', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const check = createChartMetadataCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: TAG });
    const fileDiagnostics = diagnosticsFor(document, [check], describeChartPath);

    // Nothing in this file spells the tag out, so there is no text to
    // underline and no way for the reader to find it without being told.
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, REPOSITORY));
    expect(fileDiagnostics[0]?.message).toBe(`Tag '${TAG}' not found in '${REPOSITORY}'. Tag taken from appVersion in chart/Chart.yaml.`);
  });

  it('should report nothing for a reference that exists', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    expect(diagnosticsFor(document, [createCheck({ kind: 'exists', registry: 'registry.example.com' })], describeChartPath)).toEqual([]);
  });

  it('should report nothing for any unverifiable reason, since an unreachable registry is not a missing image', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    for (const verdict of Object.values(UNCHECKED_VERDICTS)) {
      expect(diagnosticsFor(document, [createCheck(verdict)], describeChartPath)).toEqual([]);
    }
  });
});
