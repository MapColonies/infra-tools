import type { ReadTextFile } from 'helm';

/**
 * A filesystem described as a path-to-text map.
 *
 * Chart resolution walks ancestor directories looking for metadata, so a
 * test's subject is the shape of a directory tree. Writing that shape as a
 * literal keeps it visible in the test that depends on it, where temporary
 * files would put it somewhere the reader has to go and find.
 */
function createFakeFileSystem(files: Record<string, string>): ReadTextFile {
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- a canned lookup, nothing to await
  return (path: string) => Promise.resolve(files[path]);
}

export { createFakeFileSystem };
