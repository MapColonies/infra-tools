import { describe, expect, it } from 'vitest';
import { extractImageReferences } from './extract-image-references';

describe('extractImageReferences', () => {
  it('should find a repository/tag pair under a conventional image mapping', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag: 1.19', ''].join('\n');

    const [reference] = extractImageReferences(source);

    expect(reference?.repository.text).toBe('docker.io/library/nginx');
    expect(reference?.tag?.text).toBe('1.19');
  });

  it('should read the tag from raw source text, not the value YAML parsed it into', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag: 1.10', ''].join('\n');

    const [reference] = extractImageReferences(source);

    // YAML's core schema coerces the plain scalar 1.10 to the float 1.1.
    // Reading raw source text must keep the trailing zero.
    expect(reference?.tag?.text).toBe('1.10');
  });

  it('should read a tag written as an integer as its literal text', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag: 12', ''].join('\n');

    const [reference] = extractImageReferences(source);

    expect(reference?.tag?.text).toBe('12');
  });

  it('should report source ranges that point at the exact scalar text', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag: 1.10', ''].join('\n');

    const [reference] = extractImageReferences(source);
    const repository = reference?.repository;
    const tag = reference?.tag;

    expect(repository).toBeDefined();
    expect(tag).toBeDefined();
    expect(source.slice(repository!.range.start, repository!.range.end)).toBe('docker.io/library/nginx');
    expect(source.slice(tag!.range.start, tag!.range.end)).toBe('1.10');
  });

  it('should strip matching quotes and adjust the range to the unquoted text', () => {
    const source = ['image:', '  repository: "docker.io/library/nginx"', "  tag: '1.10'", ''].join('\n');

    const [reference] = extractImageReferences(source);
    const tag = reference?.tag;

    expect(reference?.repository.text).toBe('docker.io/library/nginx');
    expect(tag?.text).toBe('1.10');
    expect(source.slice(tag!.range.start, tag!.range.end)).toBe('1.10');
  });

  it('should ignore a repository key with no corroborating sibling and no corroborating parent key', () => {
    const source = ['source:', '  repository: https://github.com/example/example.git', ''].join('\n');

    expect(extractImageReferences(source)).toHaveLength(0);
  });

  it('should ignore a mapping with only a tag key', () => {
    const source = ['release:', '  tag: v1.2.3', ''].join('\n');

    expect(extractImageReferences(source)).toHaveLength(0);
  });

  it('should report a reference as tagless when the sibling tag key holds a non-scalar value', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag:', '    channel: stable', ''].join('\n');

    const [reference] = extractImageReferences(source);

    expect(reference?.repository.text).toBe('docker.io/library/nginx');
    expect(reference?.tag).toBeUndefined();
  });

  it('should find every matching mapping regardless of nesting depth', () => {
    const source = [
      'app:',
      '  image:',
      '    repository: docker.io/library/nginx',
      '    tag: 1.19',
      'sidecar:',
      '  container:',
      '    repository: ghcr.io/example/sidecar',
      '    tag: 2.0.0',
      '',
    ].join('\n');

    const references = extractImageReferences(source);

    expect(references).toHaveLength(2);
    expect(references.map((reference) => reference.repository.text)).toEqual(['docker.io/library/nginx', 'ghcr.io/example/sidecar']);

    const [first, second] = references;

    expect(source.slice(first!.repository.range.start, first!.repository.range.end)).toBe('docker.io/library/nginx');
    expect(source.slice(second!.repository.range.start, second!.repository.range.end)).toBe('ghcr.io/example/sidecar');
    expect(first!.repository.range).not.toEqual(second!.repository.range);
  });

  it('should return an empty array for a document with no matching mapping', () => {
    const source = ['replicaCount: 3', 'service:', '  type: ClusterIP', ''].join('\n');

    expect(extractImageReferences(source)).toHaveLength(0);
  });

  describe('corroborating signals', () => {
    it('should treat a sibling pullPolicy key as corroborating on its own', () => {
      const source = ['container:', '  repository: docker.io/library/nginx', '  pullPolicy: IfNotPresent', ''].join('\n');

      const [reference] = extractImageReferences(source);

      expect(reference?.repository.text).toBe('docker.io/library/nginx');
    });

    it('should treat a sibling registry key as corroborating on its own', () => {
      const source = ['container:', '  repository: my-service', '  registry: docker.io', ''].join('\n');

      const [reference] = extractImageReferences(source);

      expect(reference?.repository.text).toBe('my-service');
    });

    it('should treat an exact parent key of image as corroborating with no sibling at all', () => {
      const source = ['image:', '  repository: docker.io/library/nginx', ''].join('\n');

      const [reference] = extractImageReferences(source);

      expect(reference?.repository.text).toBe('docker.io/library/nginx');
      expect(reference?.tag).toBeUndefined();
    });

    it('should treat a parent key ending in Image as corroborating with no sibling at all', () => {
      const source = ['sidecarImage:', '  repository: ghcr.io/example/sidecar', ''].join('\n');

      const [reference] = extractImageReferences(source);

      expect(reference?.repository.text).toBe('ghcr.io/example/sidecar');
    });

    it('should not treat a parent key merely containing "image" as corroborating', () => {
      const source = ['imageBuilder:', '  repository: https://github.com/example/example.git', ''].join('\n');

      expect(extractImageReferences(source)).toHaveLength(0);
    });
  });

  describe('tagless references', () => {
    it('should report a reference with no tag key as tagless rather than dropping it', () => {
      const source = ['image:', '  repository: docker.io/library/nginx', '  pullPolicy: Always', ''].join('\n');

      const [reference] = extractImageReferences(source);

      expect(reference?.repository.text).toBe('docker.io/library/nginx');
      expect(reference?.tag).toBeUndefined();
    });

    it('should report a reference as tagless when the tag key has nothing after the colon', () => {
      const source = ['image:', '  repository: docker.io/library/nginx', '  tag:', ''].join('\n');

      const [reference] = extractImageReferences(source);

      expect(reference?.repository.text).toBe('docker.io/library/nginx');
      expect(reference?.tag).toBeUndefined();
    });

    it('should ignore a candidate when the repository key has nothing after the colon', () => {
      const source = ['image:', '  repository:', '  tag: 1.0', ''].join('\n');

      expect(extractImageReferences(source)).toHaveLength(0);
    });
  });

  describe('Helm template syntax', () => {
    it('should produce no reference when the repository contains template syntax', () => {
      const source = ['image:', '  repository: "{{ .Values.global.registry }}/nginx"', '  tag: 1.19', ''].join('\n');

      expect(extractImageReferences(source)).toHaveLength(0);
    });

    it('should report a reference as tagless when the tag contains template syntax', () => {
      const source = ['image:', '  repository: docker.io/library/nginx', '  tag: "{{ .Chart.AppVersion }}"', ''].join('\n');

      const [reference] = extractImageReferences(source);

      expect(reference?.repository.text).toBe('docker.io/library/nginx');
      expect(reference?.tag).toBeUndefined();
    });
  });
});
