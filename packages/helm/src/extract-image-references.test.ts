import { describe, expect, it } from 'vitest';
import { extractImageReferences } from './extract-image-references';

describe('extractImageReferences', () => {
  it('should find a repository/tag pair under a conventional image mapping', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag: 1.19', ''].join('\n');

    const [reference] = extractImageReferences(source);

    expect(reference?.repository.text).toBe('docker.io/library/nginx');
    expect(reference?.tag.text).toBe('1.19');
  });

  it('should read the tag from raw source text, not the value YAML parsed it into', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag: 1.10', ''].join('\n');

    const [reference] = extractImageReferences(source);

    // YAML's core schema coerces the plain scalar 1.10 to the float 1.1.
    // Reading raw source text must keep the trailing zero.
    expect(reference?.tag.text).toBe('1.10');
  });

  it('should read a tag written as an integer as its literal text', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag: 12', ''].join('\n');

    const [reference] = extractImageReferences(source);

    expect(reference?.tag.text).toBe('12');
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

  it('should ignore a mapping with only a repository key', () => {
    const source = ['source:', '  repository: https://github.com/example/example.git', ''].join('\n');

    expect(extractImageReferences(source)).toHaveLength(0);
  });

  it('should ignore a mapping with only a tag key', () => {
    const source = ['release:', '  tag: v1.2.3', ''].join('\n');

    expect(extractImageReferences(source)).toHaveLength(0);
  });

  it('should ignore a repository key whose sibling tag is a nested mapping, not a scalar', () => {
    const source = ['image:', '  repository: docker.io/library/nginx', '  tag:', '    channel: stable', ''].join('\n');

    expect(extractImageReferences(source)).toHaveLength(0);
  });

  it('should find every matching mapping regardless of nesting depth or parent key name', () => {
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
  });

  it('should return an empty array for a document with no matching mapping', () => {
    const source = ['replicaCount: 3', 'service:', '  type: ClusterIP', ''].join('\n');

    expect(extractImageReferences(source)).toHaveLength(0);
  });
});
