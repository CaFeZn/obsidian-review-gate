import test from "node:test";
import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ReviewService,
  installReviewFileSystem,
  pendingReviewDirectory,
  type ReviewDirectoryEntry,
  type ReviewFileStat,
  type ReviewFileSystem,
  type ReviewMkdirOptions,
  type ReviewRemoveOptions,
  type ReviewWriteOptions,
} from "../packages/core/src/index";
import { ReviewWatcher } from "../packages/obsidian-plugin/src/watcher/review-watcher";
import { cleanupVault, createVault, writeVaultFile } from "./helpers";

test("proposal watcher observes atomic external saves and service reconciles revision", async () => {
  const vault = await createVault();
  let watcher: ReviewWatcher | null = null;
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    let resolveEvent: (() => void) | undefined;
    const event = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    watcher = new ReviewWatcher(vault, () => resolveEvent?.(), { debounceMs: 20 });
    await watcher.start();
    const proposalPath = path.join(
      pendingReviewDirectory(vault, review.id),
      "changes",
      "0001",
      "proposal.md",
    );
    const temporary = `${proposalPath}.external-tmp`;
    await writeFile(temporary, "external proposal\n", "utf8");
    await rename(temporary, proposalPath);
    await Promise.race([
      event,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("watcher event timeout")), 2_000),
      ),
    ]);
    const reconciled = await service.get(review.id);
    assert.equal(reconciled.revision, 2);
    assert.equal(reconciled.changes[0]?.proposalContent, "external proposal\n");
  } finally {
    watcher?.stop();
    await cleanupVault(vault);
  }
});

test("target watcher marker is advisory while status remains pending", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    await writeVaultFile(vault, "note.md", "external\n");
    const marked = await service.markPotentialConflict(review.id);
    assert.equal(marked.status, "pending");
    assert.equal(marked.conflict?.advisory, true);
  } finally {
    await cleanupVault(vault);
  }
});

test("review watcher observes changes through the installed virtual filesystem", async () => {
  const fileSystem = new WatcherFileSystem("C:/virtual-review-watcher");
  const restore = installReviewFileSystem(fileSystem);
  let watcher: ReviewWatcher | null = null;
  let resolveEvent: (() => void) | undefined;
  const event = new Promise<void>((resolve) => {
    resolveEvent = resolve;
  });

  try {
    watcher = new ReviewWatcher(fileSystem.root, () => resolveEvent?.(), {
      debounceMs: 10,
    });
    await watcher.start();
    fileSystem.updateProposal("second\n");

    await Promise.race([
      event,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("virtual watcher event timeout")), 750),
      ),
    ]);
  } finally {
    watcher?.stop();
    restore();
  }
});

class WatcherFileSystem implements ReviewFileSystem {
  public readonly root: string;
  private readonly directories: Set<string>;
  private readonly files: Map<string, string>;

  public constructor(root: string) {
    this.root = path.resolve(root);
    const reviewRoot = path.join(this.root, ".obsreview");
    const pending = path.join(reviewRoot, "pending");
    const review = path.join(pending, "review-1");
    const changes = path.join(review, "changes");
    const change = path.join(changes, "0001");
    this.directories = new Set([
      this.root,
      reviewRoot,
      pending,
      path.join(reviewRoot, "history"),
      path.join(reviewRoot, "events"),
      review,
      changes,
      change,
    ]);
    this.files = new Map([[path.join(change, "proposal.md"), "first\n"]]);
  }

  public updateProposal(content: string): void {
    const proposal = [...this.files.keys()][0];
    if (proposal === undefined) throw new WatcherFileSystemError("ENOENT");
    this.files.set(proposal, content);
  }

  public async realpath(value: string): Promise<string> {
    return path.resolve(value);
  }

  public async stat(value: string): Promise<ReviewFileStat | null> {
    const normalized = path.resolve(value);
    if (this.directories.has(normalized)) return new WatcherStat(true);
    if (this.files.has(normalized)) return new WatcherStat(false);
    return null;
  }

  public async lstat(value: string): Promise<ReviewFileStat | null> {
    return this.stat(value);
  }

  public async readFile(value: string): Promise<string> {
    const content = this.files.get(path.resolve(value));
    if (content === undefined) throw new WatcherFileSystemError("ENOENT");
    return content;
  }

  public async readdir(value: string): Promise<readonly ReviewDirectoryEntry[]> {
    const normalized = path.resolve(value);
    if (!this.directories.has(normalized)) throw new WatcherFileSystemError("ENOENT");
    const entries = new Map<string, boolean>();
    for (const directory of this.directories) {
      if (directory !== normalized && path.dirname(directory) === normalized) {
        entries.set(path.basename(directory), true);
      }
    }
    for (const file of this.files.keys()) {
      if (path.dirname(file) === normalized) entries.set(path.basename(file), false);
    }
    return [...entries.entries()].map(
      ([name, directory]) => new WatcherEntry(name, directory),
    );
  }

  public async writeFile(
    _value: string,
    _data: string,
    _options?: ReviewWriteOptions,
  ): Promise<void> {
    throw new WatcherFileSystemError("ENOTSUP");
  }

  public async mkdir(
    _value: string,
    _options?: ReviewMkdirOptions,
  ): Promise<void> {
    throw new WatcherFileSystemError("ENOTSUP");
  }

  public async rename(_source: string, _destination: string): Promise<void> {
    throw new WatcherFileSystemError("ENOTSUP");
  }

  public async rm(
    _value: string,
    _options?: ReviewRemoveOptions,
  ): Promise<void> {
    throw new WatcherFileSystemError("ENOTSUP");
  }

  public async syncFile(_value: string): Promise<void> {}

  public async syncDirectory(_value: string): Promise<void> {}
}

class WatcherStat implements ReviewFileStat {
  public readonly mtimeMs = 0;

  public constructor(private readonly directory: boolean) {}

  public isDirectory(): boolean {
    return this.directory;
  }
}

class WatcherEntry implements ReviewDirectoryEntry {
  public constructor(
    public readonly name: string,
    private readonly directory: boolean,
  ) {}

  public isDirectory(): boolean {
    return this.directory;
  }
}

class WatcherFileSystemError extends Error {
  public override readonly name = "WatcherFileSystemError";

  public constructor(public readonly code: string) {
    super(code);
  }
}
