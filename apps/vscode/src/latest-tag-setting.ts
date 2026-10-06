import * as vscode from 'vscode';

const CONFIGURATION_SECTION = 'infraTools';
const WARN_ON_LATEST_TAG_KEY = 'warnOnLatestTag';

/** The full name of the setting switching the `latest` tag warning. */
const LATEST_TAG_WARNING_SETTING = `${CONFIGURATION_SECTION}.${WARN_ON_LATEST_TAG_KEY}`;

/**
 * Whether a tag pinned to `latest` earns a warning, as the editor's merged
 * settings currently say.
 *
 * On unless explicitly switched off. A team that deliberately uses `latest`
 * in development values turns it off; anything other than `false` in
 * hand-edited JSON is not a decision to, so it keeps the default.
 */
function readWarnOnLatestTag(): boolean {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get<unknown>(WARN_ON_LATEST_TAG_KEY, true) !== false;
}

export { LATEST_TAG_WARNING_SETTING, readWarnOnLatestTag };
