import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeContext } from '../test/fake-context';
import { getLastStatusBarItem, getLastTerminal, setWarningMessageAnswer, window } from '../test/vscode-stub';
import { createLoginPrompts, DISMISSED_REGISTRIES_KEY } from './login-prompts';

const REGISTRY = 'private.example.com';
const OTHER_REGISTRY = 'other.example.com';
const LOG_IN_ACTION = 'Log in';
const DISMISS_ACTION = 'Never for this registry';

/** Every argument `showWarningMessage` was called with, flattened to the registry each notification named. */
function notifiedMessages(): string[] {
  return window.showWarningMessage.mock.calls.map(([message]) => String(message));
}

describe('login-prompts', () => {
  afterEach(() => {
    // The stub's staged answer is module-level state. Leaving one test's
    // choice in place would answer the next test's notification for it.
    setWarningMessageAnswer(undefined);
    window.showWarningMessage.mockClear();
  });

  it('should notify once per registry, however many references and files report it', async () => {
    const prompts = createLoginPrompts(createFakeContext().globalState);

    await prompts.report([REGISTRY, REGISTRY]);
    await prompts.report([REGISTRY]);
    await prompts.report([REGISTRY, OTHER_REGISTRY]);

    expect(notifiedMessages()).toHaveLength(2);
    expect(notifiedMessages()[0]).toContain(REGISTRY);
    expect(notifiedMessages()[1]).toContain(OTHER_REGISTRY);
  });

  it('should offer the two actions alongside the message', async () => {
    const prompts = createLoginPrompts(createFakeContext().globalState);

    await prompts.report([REGISTRY]);

    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(REGISTRY), LOG_IN_ACTION, DISMISS_ACTION);
  });

  it('should run the login command with the hostname already filled in', async () => {
    setWarningMessageAnswer(LOG_IN_ACTION);

    const prompts = createLoginPrompts(createFakeContext().globalState);

    await prompts.report([REGISTRY]);

    expect(getLastTerminal()?.sendText).toHaveBeenCalledWith(`docker login ${REGISTRY}`);
    expect(getLastTerminal()?.show).toHaveBeenCalled();
  });

  it('should persist a dismissal to extension state rather than to settings, and never notify that registry again', async () => {
    setWarningMessageAnswer(DISMISS_ACTION);

    const context = createFakeContext();
    const prompts = createLoginPrompts(context.globalState);

    await prompts.report([REGISTRY]);

    expect(context.globalState.get(DISMISSED_REGISTRIES_KEY)).toEqual([REGISTRY]);

    window.showWarningMessage.mockClear();
    await prompts.report([REGISTRY]);

    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('should never notify a registry dismissed in an earlier session, which is what surviving a window reload means', async () => {
    const context = createFakeContext({ [DISMISSED_REGISTRIES_KEY]: [REGISTRY] });
    const prompts = createLoginPrompts(context.globalState);

    await prompts.report([REGISTRY, OTHER_REGISTRY]);

    expect(notifiedMessages()).toHaveLength(1);
    expect(notifiedMessages()[0]).toContain(OTHER_REGISTRY);
  });

  it('should count the registries needing attention in the status bar, and stay hidden until there are any', async () => {
    const prompts = createLoginPrompts(createFakeContext().globalState);
    const statusBarItem = getLastStatusBarItem();

    expect(window.createStatusBarItem).toHaveBeenCalledWith(vscode.StatusBarAlignment.Right, expect.any(Number));
    expect(statusBarItem?.visible).toBe(false);

    await prompts.report([REGISTRY, OTHER_REGISTRY]);

    expect(statusBarItem?.visible).toBe(true);
    expect(statusBarItem?.text).toContain('2');
    expect(statusBarItem?.tooltip).toContain(REGISTRY);
    expect(statusBarItem?.tooltip).toContain(OTHER_REGISTRY);
  });

  it('should drop a dismissed registry from the count, and hide once none are left', async () => {
    setWarningMessageAnswer(DISMISS_ACTION);

    const prompts = createLoginPrompts(createFakeContext().globalState);
    const statusBarItem = getLastStatusBarItem();

    await prompts.report([REGISTRY]);

    expect(statusBarItem?.visible).toBe(false);
  });

  it('should dispose its status bar item', () => {
    const prompts = createLoginPrompts(createFakeContext().globalState);
    const statusBarItem = getLastStatusBarItem();

    prompts.dispose();

    expect(statusBarItem?.dispose).toHaveBeenCalled();
  });
});
