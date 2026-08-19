import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { reviewLayout } from "../../../core/src/storage/layout";

export interface ReviewWatcherOptions {
  readonly debounceMs?: number;
}

/**
 * Watches pending proposal/meta files and history transitions. Recursive watch
 * is attempted on platforms that support it; a directory fan-out fallback is
 * used elsewhere. Atomic-save rename bursts are coalesced by one debounce.
 */
export class ReviewWatcher {
  private watchers: FSWatcher[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private rescan: NodeJS.Timeout | null = null;
  private stopped = true;

  public constructor(
    private readonly vaultRoot: string,
    private readonly onChange: () => void | Promise<void>,
    private readonly options: ReviewWatcherOptions = {},
  ) {}

  public async start(): Promise<void> {
    this.stopped = false;
    await this.rebuild();
  }

  public stop(): void {
    this.stopped = true;
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.rescan !== null) clearTimeout(this.rescan);
    this.debounce = null;
    this.rescan = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private async rebuild(): Promise<void> {
    if (this.stopped) return;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    const layout = reviewLayout(this.vaultRoot);

    try {
      const recursive = watch(
        layout.root,
        { recursive: true, persistent: false },
        () => this.signalChange(true),
      );
      recursive.on("error", () => void this.fallbackRebuild());
      this.watchers.push(recursive);
      return;
    } catch {
      await this.installFallbackWatchers();
    }
  }

  private async fallbackRebuild(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    await this.installFallbackWatchers();
  }

  private async installFallbackWatchers(): Promise<void> {
    if (this.stopped) return;
    const layout = reviewLayout(this.vaultRoot);
    for (const root of [layout.pending, layout.history, layout.events]) {
      this.watchDirectory(root, root === layout.pending);
    }
    for (const entry of await safeReadDirectories(layout.pending)) {
      const reviewDirectory = path.join(layout.pending, entry);
      this.watchDirectory(reviewDirectory, false);
      const changesRoot = path.join(reviewDirectory, "changes");
      this.watchDirectory(changesRoot, false);
      for (const change of await safeReadDirectories(changesRoot)) {
        this.watchDirectory(path.join(changesRoot, change), false);
      }
    }
  }

  private watchDirectory(directory: string, rescanOnChange: boolean): void {
    try {
      const watcher = watch(directory, { persistent: false }, () => {
        this.signalChange(rescanOnChange);
      });
      watcher.on("error", () => this.scheduleRescan());
      this.watchers.push(watcher);
    } catch {
      // A directory can disappear during pending -> history rename. Parent
      // watchers schedule a complete fan-out rebuild.
    }
  }

  private signalChange(needsRescan: boolean): void {
    if (this.stopped) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.onChange();
    }, this.options.debounceMs ?? 150);
    if (needsRescan) this.scheduleRescan();
  }

  private scheduleRescan(): void {
    if (this.stopped) return;
    if (this.rescan !== null) clearTimeout(this.rescan);
    this.rescan = setTimeout(() => {
      this.rescan = null;
      void this.rebuild();
    }, 250);
  }
}

async function safeReadDirectories(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
