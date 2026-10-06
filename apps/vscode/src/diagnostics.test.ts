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

const DEFAULT_OPTIONS = { describeChartPath, warnOnLatestTag: true };
// The same reference as VALUES_YAML, pinned to `latest` instead, so the
// repository sits at the same offsets in both.
const LATEST_VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, '  tag: "latest"', ''].join('\n');

/** The source range of `text`'s first occurrence in `yaml`. */
function rangeOfText(text: string, yaml = VALUES_YAML): SourceRange {
  const start = yaml.indexOf(text);

  return { start, end: start + text.length };
}

/** The document range covering `text`'s first occurrence in `yaml`. */
function documentRangeOfText(document: vscode.TextDocument, text: string, yaml = VALUES_YAML): vscode.Range {
  const { start, end } = rangeOfText(text, yaml);

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

/** The reference in {@link LATEST_VALUES_YAML}, its tag written in the file. */
function createLatestCheck(verdict: ImageVerdict): ReferenceCheck {
  return createCheck(verdict, { source: 'file', text: 'latest', range: rangeOfText('latest', LATEST_VALUES_YAML) });
}

/** The same reference written without a tag, checked against the chart's `appVersion` instead. */
function createChartMetadataCheck(verdict: ImageVerdict): ReferenceCheck {
  return createCheck(verdict, { source: 'chart-metadata', text: TAG, metadataPath: CHART_METADATA_PATH });
}

describe('diagnostics', () => {
  it('should report an error naming the missing repository, positioned on the repository value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createCheck({ kind: 'repository-not-found', repository: REPOSITORY })], DEFAULT_OPTIONS);

    expect(fileDiagnostics).toHaveLength(1);
    expect(fileDiagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(fileDiagnostics[0]?.message).toContain(REPOSITORY);
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, REPOSITORY));
  });

  it('should report an error naming the missing tag, positioned on the tag value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: TAG })], DEFAULT_OPTIONS);

    expect(fileDiagnostics).toHaveLength(1);
    expect(fileDiagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(fileDiagnostics[0]?.message).toBe(`Tag '${TAG}' not found in '${REPOSITORY}'.`);
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, TAG));
  });

  it('should attach a tag taken from chart metadata to the repository value, and name the chart it came from', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const check = createChartMetadataCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: TAG });
    const fileDiagnostics = diagnosticsFor(document, [check], DEFAULT_OPTIONS);

    // Nothing in this file spells the tag out, so there is no text to
    // underline and no way for the reader to find it without being told.
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, REPOSITORY));
    expect(fileDiagnostics[0]?.message).toBe(`Tag '${TAG}' not found in '${REPOSITORY}'. Tag taken from appVersion in chart/Chart.yaml.`);
  });

  it('should name the registry override set when it redirected a tag check, since the Problems panel shows nothing else', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const check = createCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: TAG, overrideRegistries: ['ghcr.io', 'quay.io'] });
    const fileDiagnostics = diagnosticsFor(document, [check], DEFAULT_OPTIONS);

    expect(fileDiagnostics[0]?.message).toBe(
      `Tag '${TAG}' not found in '${REPOSITORY}'. Registry override in effect: checked only ghcr.io, quay.io.`
    );
  });

  it('should name the registry override set when it redirected a repository check', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const check = createCheck({ kind: 'repository-not-found', repository: REPOSITORY, overrideRegistries: ['ghcr.io'] });
    const fileDiagnostics = diagnosticsFor(document, [check], DEFAULT_OPTIONS);

    expect(fileDiagnostics[0]?.message).toBe(`Repository '${REPOSITORY}' not found. Registry override in effect: checked only ghcr.io.`);
  });

  it('should report nothing for a reference that exists', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    expect(diagnosticsFor(document, [createCheck({ kind: 'exists', registry: 'registry.example.com' })], DEFAULT_OPTIONS)).toEqual([]);
  });

  it('should report nothing for any unverifiable reason, since an unreachable registry is not a missing image', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    for (const verdict of Object.values(UNCHECKED_VERDICTS)) {
      expect(diagnosticsFor(document, [createCheck(verdict)], DEFAULT_OPTIONS)).toEqual([]);
    }
  });

  it('should warn on a tag pinned to latest, positioned on the tag value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', LATEST_VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createLatestCheck({ kind: 'exists', registry: 'registry.example.com' })], DEFAULT_OPTIONS);

    expect(fileDiagnostics).toHaveLength(1);
    expect(fileDiagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(fileDiagnostics[0]?.message).toBe(
      `Image '${REPOSITORY}' is pinned to the 'latest' tag, so what deploys can change without this file changing.`
    );
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, 'latest', LATEST_VALUES_YAML));
  });

  it('should both warn and report an error for a latest tag that does not exist', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', LATEST_VALUES_YAML);
    const check = createLatestCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: 'latest' });
    const fileDiagnostics = diagnosticsFor(document, [check], DEFAULT_OPTIONS);

    expect(fileDiagnostics.map(({ severity }) => severity)).toEqual(
      expect.arrayContaining([vscode.DiagnosticSeverity.Error, vscode.DiagnosticSeverity.Warning])
    );
    expect(fileDiagnostics).toHaveLength(2);
    expect(fileDiagnostics.map(({ range }) => range)).toEqual([
      documentRangeOfText(document, 'latest', LATEST_VALUES_YAML),
      documentRangeOfText(document, 'latest', LATEST_VALUES_YAML),
    ]);
  });

  it('should warn on latest even when the registry could not be asked, since the rule is about the file', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', LATEST_VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createLatestCheck({ kind: 'unverifiable', reason: 'network-error' })], DEFAULT_OPTIONS);

    expect(fileDiagnostics.map(({ severity }) => severity)).toEqual([vscode.DiagnosticSeverity.Warning]);
  });

  it('should not warn on a tag that only starts with latest, since it names a different tag', () => {
    const yaml = ['image:', `  repository: ${REPOSITORY}`, '  tag: "latest-alpine"', ''].join('\n');
    const document = createFakeDocument('/repo/chart/values.yaml', yaml);
    const check = createCheck(
      { kind: 'exists', registry: 'registry.example.com' },
      { source: 'file', text: 'latest-alpine', range: rangeOfText('latest-alpine', yaml) }
    );

    expect(diagnosticsFor(document, [check], DEFAULT_OPTIONS)).toEqual([]);
  });

  it('should not warn on latest taken from chart metadata, since this file pins nothing', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const check = createCheck(
      { kind: 'exists', registry: 'registry.example.com' },
      { source: 'chart-metadata', text: 'latest', metadataPath: CHART_METADATA_PATH }
    );

    expect(diagnosticsFor(document, [check], DEFAULT_OPTIONS)).toEqual([]);
  });

  it('should drop the latest warning but keep the error when the warning is switched off', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', LATEST_VALUES_YAML);
    const check = createLatestCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: 'latest' });
    const fileDiagnostics = diagnosticsFor(document, [check], { describeChartPath, warnOnLatestTag: false });

    expect(fileDiagnostics.map(({ severity }) => severity)).toEqual([vscode.DiagnosticSeverity.Error]);
  });
});
