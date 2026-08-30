import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { activate, deactivate } from './extension';

describe('extension', () => {
  it('should create an output channel and register it for disposal on activate', () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    activate(context);

    expect(vscode.window.createOutputChannel).toHaveBeenCalledWith('Infra Tools');
    expect(context.subscriptions).toHaveLength(1);
  });

  it('should not throw on deactivate', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
