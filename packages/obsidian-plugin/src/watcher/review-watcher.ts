import path from "node:path";
import {
  isFileSystemError,
  readFile,
  readdir,
  type ReviewDirectoryEntry,
} from "../../../core/src/storage/file-system";
import { reviewLayout } from "../../../core/src/storage/layout";

export interface ReviewWatcherOptions {
  readonly debounceMs?: number;
  readonly pollMs?: number;
}

export class ReviewWatcher {
  private debounce: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private fingerprint = "";
  private stopped = true;

  public constructor(
    private readonly storageBase: string,
    private readonly onChange: () => void | Promise<void>,
    private readonly options: ReviewWatcherOptions = {},
  ) {}

  public async start(): Promise<void> {
    this.stopped = false;
    this.fingerprint = await reviewFingerprint(this.storageBase);
    this.schedulePoll();
  }

  public stop(): void {
    this.stopped = true;
    if (this.debounce !== null) clearTimeout(this.debounce);
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.debounce = null;
    this.pollTimer = null;
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, this.options.pollMs ?? 250);
  }

  private async poll(): Promise<void> {
    try {
      if (this.stopped) return;
      const next = await reviewFingerprint(this.storageBase);
      if (next !== this.fingerprint) {
        this.fingerprint = next;
        this.signalChange();
      }
    } finally {
      this.schedulePoll();
    }
  }

  private signalChange(): void {
    if (this.stopped) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.onChange();
    }, this.options.debounceMs ?? 150);
  }
}

async function reviewFingerprint(storageBase: string): Promise<string> {
  const layout = reviewLayout(storageBase);
  const snapshots = await Promise.all(
    [layout.pending, layout.history, layout.events].map((root) =>
      snapshotDirectory(root, root),
    ),
  );
  return JSON.stringify(snapshots);
}

async function snapshotDirectory(
  root: string,
  directory: string,
): Promise<readonly string[]> {
  let entries: readonly ReviewDirectoryEntry[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") {
      return [`missing:${relativePath(root, directory)}`];
    }
    throw error;
  }

  const snapshot: string[] = [];
  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolute = path.join(directory, entry.name);
    const relative = relativePath(root, absolute);
    if (entry.isDirectory()) {
      snapshot.push(`directory:${relative}`);
      snapshot.push(...(await snapshotDirectory(root, absolute)));
      continue;
    }
    try {
      snapshot.push(`file:${relative}:${await readFile(absolute, "utf8")}`);
    } catch (error) {
      if (isFileSystemError(error) && error.code === "ENOENT") {
        snapshot.push(`missing:${relative}`);
        continue;
      }
      throw error;
    }
  }
  return snapshot;
}

function relativePath(root: string, value: string): string {
  return path.relative(root, value).split(path.sep).join("/");
}
