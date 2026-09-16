import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { SourceRange } from 'helm';
import { bumpVersion, createFakeDocument } from '../test/fake-document';
import { createTextEditorStub, type TextEditorStub } from '../test/vscode-stub';
import { applyMarks, createMarkDecorationType, marksFor } from './marks';
import type { DocumentChecks, ReferenceCheck, ReferenceVerdict } from './reference-check';

const REPOSITORY = 'registry.example.com/svc';
const TAG = '1.0';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: "${TAG}"`, ''].join('\n');

const VERIFIED_VERDICT: ReferenceVerdict = { kind: 'exists', registry: 'registry.example.com' };
const MISSING_VERDICT: ReferenceVerdict = { kind: 'tag-not-found', repository: REPOSITORY, tag: TAG };
const UNCHECKED_VERDICT: ReferenceVerdict = { kind: 'unverifiable', reason: 'network-error' };

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

/** The stub editors, as the editor list `applyMarks` takes. */
function asEditors(editors: readonly TextEditorStub[]): readonly vscode.TextEditor[] {
  return editors as unknown as readonly vscode.TextEditor[];
}

/** One document's stored checks, tagged with the version it currently has. */
function createChecksByDocument(document: vscode.TextDocument, checks: readonly ReferenceCheck[]): Map<string, DocumentChecks> {
  return new Map([[document.uri.toString(), { version: document.version, checks }]]);
}

/** An editor that throws the way a disposed one does. */
function createDisposedEditorStub(document: vscode.TextDocument): TextEditorStub {
  return {
    document,
    setDecorations: vi.fn(() => {
      throw new Error('TextEditor#setDecorations: editor disposed');
    }),
  };
}

describe('marks', () => {
  it('should produce one mark per check, whatever each outcome was', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const checks = [createCheck(VERIFIED_VERDICT), createCheck(MISSING_VERDICT), createCheck(UNCHECKED_VERDICT)];

    expect(marksFor(document, checks)).toHaveLength(checks.length);
  });

  it('should render its own glyph and colour for each of verified, missing and unchecked', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const marks = marksFor(document, [createCheck(VERIFIED_VERDICT), createCheck(MISSING_VERDICT), createCheck(UNCHECKED_VERDICT)]);

    expect(marks.map((mark) => mark.renderOptions?.after?.contentText)).toEqual([' ✓', ' ✗', ' ?']);
    expect(marks.map((mark) => mark.renderOptions?.after?.color)).toEqual([
      new vscode.ThemeColor('charts.green'),
      new vscode.ThemeColor('errorForeground'),
      new vscode.ThemeColor('descriptionForeground'),
    ]);
  });

  it('should name the answering registry only when it differs from the host the file names', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const [namedHost] = marksFor(document, [createCheck(VERIFIED_VERDICT)]);
    const [otherHost] = marksFor(document, [createCheck({ kind: 'exists', registry: 'mirror.example.com' })]);

    expect(namedHost?.renderOptions?.after?.contentText).toBe(' ✓');
    expect(otherHost?.renderOptions?.after?.contentText).toBe(' ✓ mirror.example.com');
  });

  it('should name the answering registry for a repository that names no host at all', () => {
    const bareYaml = ['image:', '  repository: nginx', '  tag: "1.0"', ''].join('\n');
    const document = createFakeDocument('/repo/chart/values.yaml', bareYaml);
    const reference = {
      repository: { text: 'nginx', range: { start: bareYaml.indexOf('nginx'), end: bareYaml.indexOf('nginx') + 'nginx'.length } },
      tag: undefined,
      registry: undefined,
    };

    const [mark] = marksFor(document, [{ reference, verdict: { kind: 'exists', registry: 'docker.io' } }]);

    // A file that spells out no registry cannot have the answer restated to
    // it, so naming Docker Hub is the only way the mark says where it looked.
    expect(mark?.renderOptions?.after?.contentText).toBe(' ✓ docker.io');
  });

  it('should place the mark on the repository value', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const [mark] = marksFor(document, [createCheck(VERIFIED_VERDICT)]);
    const { start, end } = rangeOfText(REPOSITORY);

    expect(mark?.range).toEqual(new vscode.Range(document.positionAt(start), document.positionAt(end)));
  });

  it('should leave an editor whose document has no stored checks alone', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const editor = createTextEditorStub(document);

    applyMarks(asEditors([editor]), new Map(), createMarkDecorationType());

    expect(editor.setDecorations).not.toHaveBeenCalled();
  });

  it('should still decorate the surviving editors when one of them was disposed', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const checks = [createCheck(VERIFIED_VERDICT)];
    const decorationType = createMarkDecorationType();
    const survivingEditor = createTextEditorStub(document);

    applyMarks(asEditors([createDisposedEditorStub(document), survivingEditor]), createChecksByDocument(document, checks), decorationType);

    expect(survivingEditor.setDecorations).toHaveBeenCalledWith(decorationType, marksFor(document, checks));
  });

  it('should drop marks rather than re-project them onto text edited since the check', () => {
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const checksByDocument = createChecksByDocument(document, [createCheck(VERIFIED_VERDICT)]);
    const decorationType = createMarkDecorationType();
    const editor = createTextEditorStub(document);

    bumpVersion(document);
    applyMarks(asEditors([editor]), checksByDocument, decorationType);

    expect(editor.setDecorations).toHaveBeenCalledWith(decorationType, []);
  });
});
