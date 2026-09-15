import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from 'oci-registry';
import { bumpVersion, createFakeDocument } from '../test/fake-document';
import { fakeFetchResponse } from '../test/fake-fetch';
import { checkImageReferencesInDocument, checksAsOf, isHelmValuesFile, type DocumentChecks } from './reference-check';

const REPOSITORY = 'docker.io/library/nginx';
const TAG = '1.19';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: ${TAG}`, ''].join('\n');
const TAGLESS_VALUES_YAML = ['image:', '  repository: registry.example.com/svc', '  pullPolicy: IfNotPresent', ''].join('\n');

/** Checks a document this feature is expected to have something to say about. */
async function checkValuesFile(document: vscode.TextDocument, fetch: FetchLike): Promise<DocumentChecks> {
  const checked = await checkImageReferencesInDocument(document, fetch);

  if (checked === undefined) {
    throw new Error('expected the document to be checked');
  }

  return checked;
}

describe('reference-check', () => {
  it('should ignore a document that is not the conventional values file name', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/deployment.yaml', VALUES_YAML);

    expect(isHelmValuesFile(document)).toBe(false);
    await expect(checkImageReferencesInDocument(document, fetch)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should ignore a document whose language is not yaml', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML, 'plaintext');

    expect(isHelmValuesFile(document)).toBe(false);
    await expect(checkImageReferencesInDocument(document, fetch)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return no checks for a values file whose YAML does not parse', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/values.yaml', ['image:', '  repository: [unclosed', ''].join('\n'));

    // The extractor collects YAML errors instead of throwing, so a malformed
    // file yields zero references rather than the `undefined` that means this
    // feature has nothing to say about the document.
    await expect(checkValuesFile(document, fetch)).resolves.toEqual({ version: document.version, checks: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should ask no registry about a tagless reference, and report it as unverifiable', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.verdict).toEqual({ kind: 'unverifiable', reason: 'no-tag' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return the verdict the registry answer implies for a tagged reference', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.reference.repository.text).toBe(REPOSITORY);
    expect(checks[0]?.verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should tag the checks with the version of the document they describe', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    bumpVersion(document);

    const { version } = await checkValuesFile(document, fetch);

    expect(version).toBe(document.version);
  });

  it('should hand back the checks at the version they describe, and none once the document has moved on', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const checked = await checkValuesFile(document, fetch);

    expect(checksAsOf(checked, document)).toEqual(checked.checks);

    bumpVersion(document);

    expect(checksAsOf(checked, document)).toEqual([]);
  });
});
