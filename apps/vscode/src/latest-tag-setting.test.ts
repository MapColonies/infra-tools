import { afterEach, describe, expect, it } from 'vitest';
import { setConfiguration } from '../test/vscode-stub';
import { LATEST_TAG_WARNING_SETTING, readWarnOnLatestTag } from './latest-tag-setting';

describe('latest tag setting', () => {
  afterEach(() => {
    setConfiguration({});
  });

  it('should warn by default when the setting is absent', () => {
    expect(readWarnOnLatestTag()).toBe(true);
  });

  it('should not warn once the setting is switched off', () => {
    setConfiguration({ [LATEST_TAG_WARNING_SETTING]: false });

    expect(readWarnOnLatestTag()).toBe(false);
  });

  it('should keep warning when the setting holds something other than a boolean', () => {
    // Settings JSON is hand-edited, and the schema only warns about a bad value.
    setConfiguration({ [LATEST_TAG_WARNING_SETTING]: 'no' });

    expect(readWarnOnLatestTag()).toBe(true);
  });
});
