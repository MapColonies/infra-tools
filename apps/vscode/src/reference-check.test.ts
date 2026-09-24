import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type { ReadTextFile } from 'helm';
import type { FetchLike } from 'oci-registry';
import { bumpVersion, createFakeDocument } from '../test/fake-document';
import { noDockerCredentials } from '../test/fake-credentials';
import { createFakeFileSystem } from '../test/fake-file-system';
import { fakeFetchResponse } from '../test/fake-fetch';
import { checkImageReferencesInDocument, checksAsOf, type DocumentChecks } from './reference-check';

const REPOSITORY = 'docker.io/library/nginx';
const TAG = '1.19';
const VALUES_YAML = ['image:', `  repository: ${REPOSITORY}`, `  tag: ${TAG}`, ''].join('\n');
// A public registry, because a private one is settled as `needs-login`
// before any request and would say nothing about which tag was checked.
const TAGLESS_VALUES_YAML = ['image:', '  repository: ghcr.io/my-org/my-service', '  pullPolicy: IfNotPresent', ''].join('\n');
const DECLARED_REGISTRY_VALUES_YAML = ['global:', '  imageRegistry: ghcr.io', 'image:', '  repository: my-org/my-service', '  tag: 1.0.0', ''].join(
  '\n'
);
const BARE_VALUES_YAML = ['image:', '  repository: my-service', '  tag: 1.0.0', ''].join('\n');
const PUBLIC_BARE_VALUES_YAML = ['image:', '  repository: nginx', '  tag: 1.19', ''].join('\n');

const CHART_YAML = ['apiVersion: v2', 'name: my-service', 'appVersion: 1.2.3', ''].join('\n');
const SUBCHART_YAML = ['apiVersion: v2', 'name: sub', 'appVersion: 4.5.6', ''].join('\n');
const APPVERSIONLESS_CHART_YAML = ['apiVersion: v2', 'name: my-service', ''].join('\n');

// A workspace holding no chart metadata at all. The fixtures named
// `values.yaml` still resolve through the filename fallback, which is what
// keeps a values file open on its own working.
const NO_FILES = createFakeFileSystem({});
const ONE_CHART = createFakeFileSystem({ '/repo/chart/Chart.yaml': CHART_YAML });

/** Checks a document this feature is expected to have something to say about. */
async function checkValuesFile(document: vscode.TextDocument, fetch: FetchLike, readTextFile: ReadTextFile = NO_FILES): Promise<DocumentChecks> {
  const checked = await checkImageReferencesInDocument(document, { fetch, credentials: noDockerCredentials, readTextFile });

  if (checked === undefined) {
    throw new Error('expected the document to be checked');
  }

  return checked;
}

describe('reference-check', () => {
  it('should ignore a document that is neither named as a values file nor sits under a chart', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/deployment.yaml', VALUES_YAML);

    await expect(
      checkImageReferencesInDocument(document, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES })
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should ignore a document whose language is not yaml', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML, 'plaintext');

    await expect(
      checkImageReferencesInDocument(document, { fetch, credentials: noDockerCredentials, readTextFile: NO_FILES })
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should check any yaml file beneath a chart directory, whatever it is named', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/production.yaml', VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch, ONE_CHART);

    expect(checks).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should ignore a file under the chart templates directory, where nothing renders to a real reference', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/templates/values.yaml', VALUES_YAML);

    await expect(
      checkImageReferencesInDocument(document, { fetch, credentials: noDockerCredentials, readTextFile: ONE_CHART })
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should return no checks for a values file whose YAML does not parse', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/values.yaml', ['image:', '  repository: [unclosed', ''].join('\n'));

    // The extractor collects YAML errors instead of throwing, so a malformed
    // file yields zero references rather than the `undefined` that means this
    // feature has nothing to say about the document.
    await expect(checkValuesFile(document, fetch)).resolves.toEqual({ version: document.version, checks: [], chartMetadataPath: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should check a tagless reference against the governing chart appVersion', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);

    await checkValuesFile(document, fetch, ONE_CHART);

    expect(fetch).toHaveBeenCalledWith('https://ghcr.io/v2/my-org/my-service/manifests/1.2.3', expect.anything());
  });

  it('should record where a tag taken from chart metadata came from', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch, ONE_CHART);

    expect(checks[0]?.tag).toEqual({ source: 'chart-metadata', text: '1.2.3', metadataPath: '/repo/chart/Chart.yaml' });
  });

  it('should resolve a subchart values file against the subchart own appVersion, not the parent chart', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/charts/sub/values.yaml', TAGLESS_VALUES_YAML);
    const readTextFile = createFakeFileSystem({
      '/repo/chart/Chart.yaml': CHART_YAML,
      '/repo/chart/charts/sub/Chart.yaml': SUBCHART_YAML,
    });

    await checkValuesFile(document, fetch, readTextFile);

    // The parent's 1.2.3 is what Helm would ignore here, so asking about it
    // would report on a release nobody is deploying.
    expect(fetch).toHaveBeenCalledWith('https://ghcr.io/v2/my-org/my-service/manifests/4.5.6', expect.anything());
  });

  it('should produce no check at all for a tagless reference no chart metadata can resolve', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch);

    // Silence, not an unchecked mark: there is nothing to check it against
    // and nothing the developer could do about a mark saying so.
    expect(checks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should produce no check for a tagless reference whose governing chart declares no appVersion', async () => {
    const fetch = vi.fn();
    const document = createFakeDocument('/repo/chart/values.yaml', TAGLESS_VALUES_YAML);
    const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': APPVERSIONLESS_CHART_YAML });

    const { checks } = await checkValuesFile(document, fetch, readTextFile);

    expect(checks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('should report the chart metadata file the checks depend on', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const governed = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);
    const standalone = createFakeDocument('/elsewhere/values.yaml', VALUES_YAML);

    await expect(checkValuesFile(governed, fetch, ONE_CHART)).resolves.toMatchObject({ chartMetadataPath: '/repo/chart/Chart.yaml' });
    await expect(checkValuesFile(standalone, fetch)).resolves.toMatchObject({ chartMetadataPath: undefined });
  });

  it('should return the verdict the registry answer implies for a tagged reference', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.reference.repository.text).toBe(REPOSITORY);
    expect(checks[0]?.tag).toEqual({
      source: 'file',
      text: TAG,
      range: { start: VALUES_YAML.indexOf(TAG), end: VALUES_YAML.indexOf(TAG) + TAG.length },
    });
    expect(checks[0]?.verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('should prefer the tag the file writes over the governing chart appVersion', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', VALUES_YAML);

    await checkValuesFile(document, fetch, ONE_CHART);

    expect(fetch).toHaveBeenCalledWith(`https://registry-1.docker.io/v2/library/nginx/manifests/${TAG}`, expect.anything());
  });

  it('should check a bare repository against the registry its document declares', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', DECLARED_REGISTRY_VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch);

    expect(fetch).toHaveBeenCalledWith('https://ghcr.io/v2/my-org/my-service/manifests/1.0.0', expect.anything());
    expect(checks[0]?.verdict).toEqual({ kind: 'exists', registry: 'ghcr.io' });
  });

  it('should leave a bare repository Docker Hub has never heard of unverifiable rather than missing', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(404, { errors: [{ code: 'NAME_UNKNOWN' }] }));
    const document = createFakeDocument('/repo/chart/values.yaml', BARE_VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch);

    // An internal service name is the ordinary case in this organisation's
    // charts, and Docker Hub was only ever a guess about where to look.
    // `diagnostics.test.ts` is where that reason is pinned to no diagnostic.
    expect(checks[0]?.verdict).toEqual({ kind: 'unverifiable', reason: 'guessed-registry' });
  });

  it('should verify a bare public name against Docker Hub under the library namespace', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeFetchResponse(200));
    const document = createFakeDocument('/repo/chart/values.yaml', PUBLIC_BARE_VALUES_YAML);

    const { checks } = await checkValuesFile(document, fetch);

    expect(fetch).toHaveBeenCalledWith('https://registry-1.docker.io/v2/library/nginx/manifests/1.19', expect.anything());
    expect(checks[0]?.verdict).toEqual({ kind: 'exists', registry: 'docker.io' });
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
