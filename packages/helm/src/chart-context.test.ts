import { describe, expect, it } from 'vitest';
import { resolveTag, resolveValuesFileContext, type ChartMetadata, type ReadTextFile } from './chart-context';
import type { ImageReference } from './extract-image-references';

/**
 * A file system described as a path-to-contents record, so a test states the
 * directory shape it is about instead of writing temporary files.
 */
function createFakeFileSystem(files: Record<string, string>): ReadTextFile {
  return async (path) => Promise.resolve(files[path]);
}

/** A reference whose only field `resolveTag` reads is the tag. */
function createReference(tag: string | undefined): ImageReference {
  return {
    repository: { text: 'my-service', range: { start: 0, end: 10 } },
    tag: tag === undefined ? undefined : { text: tag, range: { start: 20, end: 20 + tag.length } },
    registry: undefined,
  };
}

const CHART_METADATA = ['name: my-chart', 'appVersion: 1.2.3', ''].join('\n');

describe('resolveValuesFileContext', () => {
  it('should resolve a values file against the chart in its own directory', async () => {
    const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': CHART_METADATA });

    const context = await resolveValuesFileContext('/repo/chart/values.yaml', readTextFile);

    expect(context?.chart?.path).toBe('/repo/chart/Chart.yaml');
    expect(context?.chart?.appVersion).toBe('1.2.3');
  });

  it('should resolve a values file several directories deep against the chart above it', async () => {
    const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': CHART_METADATA });

    const context = await resolveValuesFileContext('/repo/chart/env/production/values.yaml', readTextFile);

    expect(context?.chart?.path).toBe('/repo/chart/Chart.yaml');
  });

  it('should resolve a subchart values file against the subchart own metadata', async () => {
    const readTextFile = createFakeFileSystem({
      '/repo/chart/Chart.yaml': ['name: parent', 'appVersion: 1.0.0', ''].join('\n'),
      '/repo/chart/charts/sub/Chart.yaml': ['name: sub', 'appVersion: 2.0.0', ''].join('\n'),
    });

    const context = await resolveValuesFileContext('/repo/chart/charts/sub/values.yaml', readTextFile);

    expect(context?.chart?.path).toBe('/repo/chart/charts/sub/Chart.yaml');
    expect(context?.chart?.appVersion).toBe('2.0.0');
  });

  it('should find chart metadata written as Chart.yml', async () => {
    const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yml': CHART_METADATA });

    const context = await resolveValuesFileContext('/repo/chart/values.yaml', readTextFile);

    expect(context?.chart?.path).toBe('/repo/chart/Chart.yml');
    expect(context?.chart?.appVersion).toBe('1.2.3');
  });

  it('should treat any yaml file beneath a chart directory as in scope', async () => {
    const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': CHART_METADATA });

    const context = await resolveValuesFileContext('/repo/chart/production.yaml', readTextFile);

    expect(context?.chart?.path).toBe('/repo/chart/Chart.yaml');
  });

  it('should find chart metadata sitting at the filesystem root', async () => {
    const readTextFile = createFakeFileSystem({ '/Chart.yaml': CHART_METADATA });

    const context = await resolveValuesFileContext('/values.yaml', readTextFile);

    expect(context?.chart?.path).toBe('/Chart.yaml');
  });

  it('should exclude a file under the chart templates directory', async () => {
    const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': CHART_METADATA });

    await expect(resolveValuesFileContext('/repo/chart/templates/deployment.yaml', readTextFile)).resolves.toBeUndefined();
  });

  it('should exclude a file named values.yaml under the chart templates directory', async () => {
    const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': CHART_METADATA });

    await expect(resolveValuesFileContext('/repo/chart/templates/values.yaml', readTextFile)).resolves.toBeUndefined();
  });

  it('should exclude a subchart templates file against the subchart rather than against its parent', async () => {
    const readTextFile = createFakeFileSystem({
      '/repo/chart/Chart.yaml': ['name: parent', 'appVersion: 1.0.0', ''].join('\n'),
      '/repo/chart/charts/sub/Chart.yaml': ['name: sub', 'appVersion: 2.0.0', ''].join('\n'),
    });

    // Relative to the parent chart this path reads `charts/sub/templates/...`,
    // which no `templates/` rule would exclude.
    await expect(resolveValuesFileContext('/repo/chart/charts/sub/templates/values.yaml', readTextFile)).resolves.toBeUndefined();
  });

  it('should treat a standalone values.yaml with no chart above it as in scope with no chart', async () => {
    const readTextFile = createFakeFileSystem({});

    const context = await resolveValuesFileContext('/repo/loose/values.yaml', readTextFile);

    expect(context).toEqual({ chart: undefined });
  });

  it('should ignore an unrelated yaml file with no chart above it', async () => {
    const readTextFile = createFakeFileSystem({});

    await expect(resolveValuesFileContext('/repo/loose/config.yaml', readTextFile)).resolves.toBeUndefined();
  });

  describe('appVersion', () => {
    it('should report no appVersion when the chart declares none', async () => {
      const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': ['name: my-chart', 'version: 0.1.0', ''].join('\n') });

      const context = await resolveValuesFileContext('/repo/chart/values.yaml', readTextFile);

      expect(context?.chart?.path).toBe('/repo/chart/Chart.yaml');
      expect(context?.chart?.appVersion).toBeUndefined();
    });

    it('should read appVersion from raw source text, not the value YAML parsed it into', async () => {
      const readTextFile = createFakeFileSystem({ '/repo/chart/Chart.yaml': ['name: my-chart', 'appVersion: 1.10', ''].join('\n') });

      const context = await resolveValuesFileContext('/repo/chart/values.yaml', readTextFile);

      // YAML's core schema coerces the plain scalar 1.10 to the float 1.1.
      expect(context?.chart?.appVersion).toBe('1.10');
    });

    it('should report no appVersion when the declared one contains template syntax', async () => {
      const readTextFile = createFakeFileSystem({
        '/repo/chart/Chart.yaml': ['name: my-chart', 'appVersion: "{{ .Chart.Version }}"', ''].join('\n'),
      });

      const context = await resolveValuesFileContext('/repo/chart/values.yaml', readTextFile);

      expect(context?.chart?.appVersion).toBeUndefined();
    });
  });
});

describe('resolveTag', () => {
  const chart: ChartMetadata = { path: '/repo/chart/Chart.yaml', appVersion: '1.2.3' };

  it('should prefer the tag written in the file over the chart appVersion', () => {
    const reference = createReference('9.9.9');

    expect(resolveTag(reference, chart)).toEqual({ source: 'file', text: '9.9.9', range: reference.tag?.range });
  });

  it('should fall back to the chart appVersion for a tagless reference', () => {
    expect(resolveTag(createReference(undefined), chart)).toEqual({
      source: 'chart-metadata',
      text: '1.2.3',
      metadataPath: '/repo/chart/Chart.yaml',
    });
  });

  it('should resolve nothing for a tagless reference with no chart', () => {
    expect(resolveTag(createReference(undefined), undefined)).toBeUndefined();
  });

  it('should resolve nothing for a tagless reference under a chart that declares no appVersion', () => {
    expect(resolveTag(createReference(undefined), { path: '/repo/chart/Chart.yaml', appVersion: undefined })).toBeUndefined();
  });
});
