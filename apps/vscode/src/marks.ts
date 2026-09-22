import * as vscode from 'vscode';
import type { ImageReference } from 'helm';
import { resolveExplicitHost } from 'oci-registry';
import { checksAsOf, type DocumentChecks, type ReferenceCheck, type ReferenceVerdict } from './reference-check';
import { rangeOf } from './source-range';

type MarkKind = 'verified' | 'missing' | 'unchecked';

// `unchecked` is a muted question mark rather than a cross on purpose: it
// reports a fact about the developer's machine, not a defect in the file,
// and styling it as a failure is how a linter earns being switched off.
const MARKS: Record<MarkKind, { readonly glyph: string; readonly color: string }> = {
  verified: { glyph: '✓', color: 'charts.green' },
  missing: { glyph: '✗', color: 'errorForeground' },
  unchecked: { glyph: '?', color: 'descriptionForeground' },
};

/** Exhaustive, so a new verdict kind fails the build here. */
function markKindOf(verdict: ReferenceVerdict): MarkKind {
  switch (verdict.kind) {
    case 'exists':
      return 'verified';
    case 'repository-not-found':
    case 'tag-not-found':
      return 'missing';
    case 'unverifiable':
      return 'unchecked';
  }
}

/**
 * The registry the file itself names for a reference: a host spelled out in
 * the repository, else the one the document declared for it. `undefined` when the
 * file names none, which is not the same as naming Docker Hub — the check
 * only guessed it, and the mark is the one place that difference shows.
 */
function registryNamedByFile(reference: ImageReference): string | undefined {
  return resolveExplicitHost(reference.repository.text)?.host ?? reference.registry;
}

/**
 * The answering registry, named only when it differs from the one the file
 * names, so the mark carries information instead of restating the line.
 */
function registrySuffixOf(reference: ImageReference, verdict: ReferenceVerdict): string {
  if (verdict.kind !== 'exists' || verdict.registry === registryNamedByFile(reference)) {
    return '';
  }

  return ` ${verdict.registry}`;
}

/**
 * One mark per checked reference, whatever the outcome. Glyph and colour
 * both ride on the decoration rather than the type, so all three marks share
 * one type and one `setDecorations` call per editor replaces the lot.
 */
function marksFor(document: vscode.TextDocument, checks: readonly ReferenceCheck[]): vscode.DecorationOptions[] {
  const decorations: vscode.DecorationOptions[] = [];

  for (const { reference, verdict } of checks) {
    const { glyph, color } = MARKS[markKindOf(verdict)];

    decorations.push({
      range: rangeOf(document, reference.repository.range),
      renderOptions: { after: { contentText: ` ${glyph}${registrySuffixOf(reference, verdict)}`, color: new vscode.ThemeColor(color) } },
    });
  }

  return decorations;
}

function createMarkDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({ after: { margin: '0 0 0 0.5em' } });
}

/**
 * Re-applies each editor's stored marks. An editor showing a checked
 * document always gets a `setDecorations` call, empty array included, so a
 * reference whose outcome changed loses the mark it used to have.
 */
function applyMarks(
  editors: readonly vscode.TextEditor[],
  checksByDocument: ReadonlyMap<string, DocumentChecks>,
  decorationType: vscode.TextEditorDecorationType
): void {
  for (const editor of editors) {
    const checked = checksByDocument.get(editor.document.uri.toString());

    if (checked === undefined) {
      continue;
    }

    try {
      editor.setDecorations(decorationType, marksFor(editor.document, checksAsOf(checked, editor.document)));
    } catch {
      // This runs while editors are being torn down, and `setDecorations`
      // throws on a disposed one. One dead editor must not cost every other
      // visible editor its marks.
      continue;
    }
  }
}

export { applyMarks, createMarkDecorationType, marksFor };
