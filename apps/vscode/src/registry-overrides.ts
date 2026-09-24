import * as vscode from 'vscode';

const CONFIGURATION_SECTION = 'infraTools';
const REGISTRIES_KEY = 'registries';

/** The full name of the setting holding the registry override set. */
const REGISTRY_OVERRIDES_SETTING = `${CONFIGURATION_SECTION}.${REGISTRIES_KEY}`;

// Left of the login indicator, which sits at 0: the two answer related
// questions about why a file looks the way it does, so they sit together.
const STATUS_BAR_PRIORITY = 1;

/**
 * The registry override set, as the editor's merged user and workspace
 * settings currently declare it.
 *
 * Which of the two scopes a developer uses is the editor's business, so
 * this reads the merged value and takes no position. The schema only warns
 * about a bad entry in hand-edited JSON, so anything that is not a
 * non-blank string is dropped here rather than handed on as a hostname;
 * the registry package still rejects a string that is not a valid host.
 */
function readOverrideRegistries(): string[] {
  const configured = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get<unknown>(REGISTRIES_KEY, []);

  if (!Array.isArray(configured)) {
    return [];
  }

  // Deduplicated here, not only by the registry package, so the status bar
  // counts the registries a check will actually ask.
  const entries = configured.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim());

  return [...new Set(entries.filter((entry) => entry !== ''))];
}

interface OverrideStatus {
  readonly update: (overrideRegistries: readonly string[]) => void;
  readonly dispose: () => void;
}

/**
 * The status bar item saying overrides are active. It answers "why is this
 * file green when I know that image was never pushed where it says", and
 * stays hidden while no override is declared, because then there is
 * nothing to explain.
 */
function createOverrideStatus(): OverrideStatus {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);

  return {
    update: (overrideRegistries: readonly string[]): void => {
      if (overrideRegistries.length === 0) {
        statusBarItem.hide();
        return;
      }

      statusBarItem.text = `$(arrow-swap) ${String(overrideRegistries.length)}`;
      statusBarItem.tooltip = `Registry override in effect: images are checked only against ${overrideRegistries.join(', ')}`;
      statusBarItem.show();
    },
    dispose: (): void => {
      statusBarItem.dispose();
    },
  };
}

export { createOverrideStatus, readOverrideRegistries, REGISTRY_OVERRIDES_SETTING };
