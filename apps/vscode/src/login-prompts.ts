import * as vscode from 'vscode';

// Where the dismissed registries live. In extension state rather than in
// settings, because a dismissal is not configuration: it records that one
// developer stopped caring about one registry, and putting it in settings
// would accumulate that in a file the whole team has checked in.
const DISMISSED_REGISTRIES_KEY = 'infraTools.dismissedLoginRegistries';

const LOG_IN_ACTION = 'Log in';
const DISMISS_ACTION = 'Never for this registry';

// Right of the line and column indicator, at the default priority. Nothing
// here competes for a specific slot.
const STATUS_BAR_PRIORITY = 0;

/**
 * What has already been said to the developer about one registry.
 *
 * Two states rather than a pair of sets, because every rule this surface has
 * is a statement about one of them. "At most once per registry per session"
 * is that nothing leaves `'prompted'` except into `'dismissed'`. "Never
 * again, across window reloads" is that `'dismissed'` is what gets persisted
 * and what seeds the map next time. The status bar count is simply how many
 * entries are `'prompted'`.
 */
type PromptState = 'prompted' | 'dismissed';

interface LoginPrompts {
  /**
   * Reports the registries a document's checks could not reach for want of a
   * login. Never throws and never rejects: it runs inside a document-open
   * listener, where an escaping rejection takes the extension host down.
   */
  readonly report: (registries: Iterable<string>) => Promise<void>;
  readonly dispose: () => void;
}

function readDismissedRegistries(state: vscode.Memento): string[] {
  const stored = state.get<unknown>(DISMISSED_REGISTRIES_KEY);

  return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The registries a developer has been told about, and the status bar item
 * counting them.
 *
 * This is the whole surface for a missing credential, and deliberately none
 * of it is a diagnostic. Not having logged in to a registry is a fact about
 * the developer's machine, not a defect in the values file, and putting it
 * in the Problems panel beside real errors is how a panel earns being
 * ignored.
 */
function createLoginPrompts(state: vscode.Memento): LoginPrompts {
  const promptStates = new Map<string, PromptState>(readDismissedRegistries(state).map((registry) => [registry, 'dismissed']));
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);

  function registriesIn(wanted: PromptState): string[] {
    return [...promptStates].filter(([, promptState]) => promptState === wanted).map(([registry]) => registry);
  }

  function refreshStatusBar(): void {
    const waiting = registriesIn('prompted');

    if (waiting.length === 0) {
      statusBarItem.hide();
      return;
    }

    statusBarItem.text = `$(key) ${String(waiting.length)}`;
    statusBarItem.tooltip = `Registries needing a Docker login: ${waiting.join(', ')}`;
    statusBarItem.show();
  }

  function dismiss(registry: string): Thenable<void> {
    promptStates.set(registry, 'dismissed');
    refreshStatusBar();

    return state.update(DISMISSED_REGISTRIES_KEY, registriesIn('dismissed'));
  }

  function runLogin(registry: string): void {
    // A terminal rather than a task or a child process: `docker login`
    // prompts for a password, so the developer has to be able to type into
    // whatever runs it.
    const terminal = vscode.window.createTerminal(`docker login ${registry}`);

    terminal.show();
    terminal.sendText(`docker login ${registry}`);
  }

  async function prompt(registry: string): Promise<void> {
    const action = await vscode.window.showWarningMessage(
      `No Docker credential for \`${registry}\`, so its images cannot be verified.`,
      LOG_IN_ACTION,
      DISMISS_ACTION
    );

    if (action === LOG_IN_ACTION) {
      runLogin(registry);
      return;
    }

    if (action === DISMISS_ACTION) {
      await dismiss(registry);
    }
  }

  return {
    report: async (registries: Iterable<string>): Promise<void> => {
      try {
        // Deduplicated here as well as by the caller, because `filter` reads
        // the whole batch before `map` marks any of it: a registry named
        // twice in one batch would otherwise pass the "not prompted yet"
        // test twice and raise two notifications for it.
        //
        // Every notification is raised before the first `await`, so a caller
        // that fires this and walks away still gets them all shown.
        const pending = [...new Set(registries)]
          .filter((registry) => !promptStates.has(registry))
          .map((registry) => {
            promptStates.set(registry, 'prompted');

            return registry;
          });

        if (pending.length === 0) {
          return;
        }

        refreshStatusBar();

        // Settled, not raced: a developer who dismisses the second of three
        // prompts must have that dismissal persisted before this resolves.
        await Promise.allSettled(pending.map(prompt));
      } catch {
        // The caller fires this without awaiting it, so anything escaping
        // here is an unhandled rejection, and that takes the extension host
        // down. A check already in flight when the window closes finds this
        // object's status bar item disposed, which is exactly that case.
      }
    },
    dispose: (): void => {
      statusBarItem.dispose();
    },
  };
}

export { createLoginPrompts, DISMISSED_REGISTRIES_KEY };
