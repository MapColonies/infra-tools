import { afterEach, describe, expect, it } from 'vitest';
import { getLastStatusBarItem, setConfiguration } from '../test/vscode-stub';
import { createOverrideStatus, readOverrideRegistries, REGISTRY_OVERRIDES_SETTING } from './registry-overrides';

describe('registry overrides', () => {
  afterEach(() => {
    setConfiguration({});
  });

  it('should read the declared registries from settings', () => {
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: ['ghcr.io', 'quay.io'] });

    expect(readOverrideRegistries()).toEqual(['ghcr.io', 'quay.io']);
  });

  it('should read no overrides when the setting is absent', () => {
    expect(readOverrideRegistries()).toEqual([]);
  });

  it('should ignore entries that are not hostnames written as strings, and blank ones', () => {
    // Settings JSON is hand-edited, and the schema only warns about a bad
    // entry; it still reaches the extension.
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: ['ghcr.io', 42, '', '  ', { host: 'quay.io' }] });

    expect(readOverrideRegistries()).toEqual(['ghcr.io']);
  });

  it('should read a registry listed twice once, so the status bar counts what a check will ask', () => {
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: ['ghcr.io', ' ghcr.io ', 'quay.io'] });

    expect(readOverrideRegistries()).toEqual(['ghcr.io', 'quay.io']);
  });

  it('should read no overrides when the setting is not a list', () => {
    setConfiguration({ [REGISTRY_OVERRIDES_SETTING]: 'ghcr.io' });

    expect(readOverrideRegistries()).toEqual([]);
  });

  it('should hide the status bar item while no override is active', () => {
    const status = createOverrideStatus();

    status.update([]);

    expect(getLastStatusBarItem()?.visible).toBe(false);
  });

  it('should show the active override count, and name the registries in the tooltip', () => {
    const status = createOverrideStatus();

    status.update(['ghcr.io', 'quay.io']);

    const item = getLastStatusBarItem();

    expect(item?.visible).toBe(true);
    expect(item?.text).toBe('$(arrow-swap) 2');
    expect(item?.tooltip).toBe('Registry override in effect: images are checked only against ghcr.io, quay.io');
  });

  it('should hide the status bar item again once the overrides are cleared', () => {
    const status = createOverrideStatus();

    status.update(['ghcr.io']);
    status.update([]);

    expect(getLastStatusBarItem()?.visible).toBe(false);
  });
});
