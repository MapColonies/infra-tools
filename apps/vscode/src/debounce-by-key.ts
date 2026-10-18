/** Runs work for a key once calls for that key stop arriving. */
interface KeyedDebouncer {
  /** Replaces any work still waiting for `key`, restarting its wait. */
  readonly schedule: (key: string, run: () => unknown) => void;
  /** Drops every pending run, so nothing fires after deactivation. */
  readonly dispose: () => void;
}

/**
 * Debounces per key rather than globally, so a pause in one file is not
 * held hostage by typing in another.
 */
function debounceByKey(delayMs: number): KeyedDebouncer {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    schedule: (key, run): void => {
      clearTimeout(pending.get(key));
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key);
          run();
        }, delayMs)
      );
    },
    dispose: (): void => {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }

      pending.clear();
    },
  };
}

export { debounceByKey };
