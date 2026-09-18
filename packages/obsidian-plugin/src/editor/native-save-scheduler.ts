/**
 * Coalesces rapid edits into a single deferred write.
 *
 * Obsidian's MarkdownView calls requestSave on every document update, including
 * each intermediate state of an IME composition. Writing synchronously there
 * persisted the review on every keystroke, which made typing sluggish and could
 * discard an in-progress composition. This scheduler defers the write until
 * typing pauses, and always flushes a still-pending edit when the pane closes.
 */
export interface NativeSaveSchedulerOptions {
  /** Performs the actual write. */
  readonly persist: () => Promise<void>;
  /** Delay after the last edit before writing. */
  readonly delayMs: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface NativeSaveScheduler {
  /** Records an edit and restarts the debounce window. */
  schedule(): void;
  /** Writes now if an edit is pending, bypassing the delay. */
  flush(): Promise<void>;
  /** Drops any pending write without performing it. */
  cancel(): void;
  /** True when an edit is waiting to be written. */
  hasPending(): boolean;
}

export function createNativeSaveScheduler(
  options: NativeSaveSchedulerOptions,
): NativeSaveScheduler {
  const setTimer =
    options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let handle: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (handle === null) return;
    clearTimer(handle);
    handle = null;
  };

  return {
    schedule: () => {
      cancel();
      handle = setTimer(() => {
        handle = null;
        void options.persist();
      }, options.delayMs);
    },
    flush: async () => {
      if (handle === null) return;
      cancel();
      await options.persist();
    },
    cancel,
    hasPending: () => handle !== null,
  };
}
