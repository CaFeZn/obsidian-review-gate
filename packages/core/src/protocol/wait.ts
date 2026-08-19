import { watch, type FSWatcher } from "node:fs";
import type { Review } from "../model/review";
import { ReviewError } from "../model/errors";
import { ReviewStore } from "../storage/review-store";
import { reviewLayout } from "../storage/layout";

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Blocks on filesystem notifications until the review leaves pending state.
 * No status polling loop is used. A small debounce only coalesces atomic-save
 * rename bursts before reloading the durable state.
 */
export async function waitForReview(
  store: ReviewStore,
  reviewId: string,
  options: WaitOptions = {},
): Promise<Review> {
  const initial = await store.load(reviewId);
  if (initial.status !== "pending") return initial;

  const layout = reviewLayout(store.storageBase);
  const watchRoots = [layout.events, layout.pending, layout.history];
  return new Promise<Review>((resolve, reject) => {
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;
    let debounce: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (debounce !== undefined) clearTimeout(debounce);
      options.signal?.removeEventListener("abort", onAbort);
      for (const watcher of watchers) watcher.close();
      action();
    };

    const reload = async (): Promise<void> => {
      try {
        const review = await store.load(reviewId);
        if (review.status !== "pending") finish(() => resolve(review));
      } catch (error) {
        // A pending -> history move creates a brief directory-level race. The
        // history watcher will emit another event; only non-not-found errors end wait.
        if (!(error instanceof ReviewError) || error.code !== "REVIEW_NOT_FOUND") {
          finish(() => reject(error));
        }
      }
    };

    const scheduleReload = (filename: string | Buffer | null): void => {
      if (filename !== null) {
        const name = filename.toString();
        const relevant =
          name.includes(reviewId) ||
          name === "meta.json" ||
          name.endsWith(".json");
        if (!relevant) return;
      }
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = setTimeout(() => void reload(), 25);
    };

    const onAbort = (): void => {
      finish(() =>
        reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("Wait aborted."),
        ),
      );
    };

    try {
      for (const root of watchRoots) {
        watchers.push(
          watch(root, { persistent: true }, (_event, filename) => scheduleReload(filename)),
        );
      }
    } catch (error) {
      finish(() => reject(error));
      return;
    }

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new ReviewError(
              "WAIT_TIMEOUT",
              `Timed out waiting for review ${reviewId}.`,
              { reviewId, timeoutMs: options.timeoutMs },
            ),
          ),
        );
      }, options.timeoutMs);
    }
    if (options.signal?.aborted === true) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
