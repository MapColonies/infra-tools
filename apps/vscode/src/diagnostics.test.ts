import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import type { SourceRange } from 'helm';
import { createFakeDocument } from '../test/fake-document';
import { diagnosticsFor } from './diagnostics';
import type { ReferenceCheck, ReferenceVerdict, UncheckedReason } from './reference-check';

const REPOSITORY = 'registry.example.com/svc';
const TAG = '1.0';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: "${TAG}"`, ''].join('\n');

// A record rather than a list, so a new reason fails the build here instead
// of going untested.
const UNCHECKED_REASONS: Record<UncheckedReason, true> = {
  'no-tag': true,
  'no-registry': true,
  'missing-credential': true,
  'network-error': true,
  'unexpected-response': true,
  'malformed-reference': true,
};

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
function createCheck(verdict: ReferenceVerdict): ReferenceCheck {
  return {
    reference: {
      repository: { text: REPOSITORY, range: rangeOfText(REPOSITORY) },
      tag: { text: TAG, range: rangeOfText(TAG) },
    },
    verdict,
  };
}

describe('diagnostics', () => {
  it('should report an error naming the missing repository, positioned on the repository value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createCheck({ kind: 'repository-not-found', repository: REPOSITORY })]);

    expect(fileDiagnostics).toHaveLength(1);
    expect(fileDiagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(fileDiagnostics[0]?.message).toContain(REPOSITORY);
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, REPOSITORY));
  });

  it('should report an error naming the missing tag, positioned on the tag value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const fileDiagnostics = diagnosticsFor(document, [createCheck({ kind: 'tag-not-found', repository: REPOSITORY, tag: TAG })]);

    expect(fileDiagnostics).toHaveLength(1);
    expect(fileDiagnostics[0]?.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(fileDiagnostics[0]?.message).toContain(TAG);
    expect(fileDiagnostics[0]?.range).toEqual(documentRangeOfText(document, TAG));
  });

  it('should report nothing for a reference that exists', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    expect(diagnosticsFor(document, [createCheck({ kind: 'exists', registry: 'registry.example.com' })])).toEqual([]);
  });

  it('should report nothing for any unverifiable reason, since an unreachable registry is not a missing image', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    for (const reason of Object.keys(UNCHECKED_REASONS) as UncheckedReason[]) {
      expect(diagnosticsFor(document, [createCheck({ kind: 'unverifiable', reason })])).toEqual([]);
    }
  });
});
