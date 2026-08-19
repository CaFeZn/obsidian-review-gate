import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  ReviewService,
  installReviewFileSystem,
  type ReviewDirectoryEntry,
  type ReviewFileStat,
  type ReviewFileSystem,
  type ReviewMkdirOptions,
  type ReviewRemoveOptions,
  type ReviewWriteOptions,
} from "../packages/core/src/index";

test("review lifecycle uses the installed filesystem when Node fs cannot see the vault", async () => {
  const fileSystem = new MemoryReviewFileSystem("C:/virtual-vault");
  await fileSystem.writeFile(path.join(fileSystem.root, "note.md"), "base\n");
  const restore = installReviewFileSystem(fileSystem);

  try {
    const service = (await ReviewService.open(fileSystem.root)).service;
    const submitted = await service.submit({
      changes: [{ target: "note.md", proposalContent: "approved\n" }],
    });

    assert.deepEqual((await service.list()).map((review) => review.id), [submitted.id]);

    await service.approve(submitted.id);

    assert.equal(
      await fileSystem.readFile(path.join(fileSystem.root, "note.md")),
      "approved\n",
    );
    assert.equal((await service.get(submitted.id)).status, "approved");
  } finally {
    restore();
  }
});

class MemoryReviewFileSystem implements ReviewFileSystem {
  public readonly root: string;
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();
  private clock = 1;
  private readonly modified = new Map<string, number>();

  public constructor(root: string) {
    this.root = path.resolve(root);
    this.directories.add(this.root);
    this.modified.set(this.root, this.clock);
  }

  public async realpath(value: string): Promise<string> {
    const normalized = this.normalize(value);
    if (!(await this.stat(normalized))) throw new MemoryFsError("ENOENT", normalized);
    return normalized;
  }

  public async stat(value: string): Promise<ReviewFileStat | null> {
    const normalized = this.normalize(value);
    if (this.files.has(normalized)) {
      return new MemoryStat(false, this.modified.get(normalized) ?? 0);
    }
    if (this.directories.has(normalized)) {
      return new MemoryStat(true, this.modified.get(normalized) ?? 0);
    }
    return null;
  }

  public async lstat(value: string): Promise<ReviewFileStat | null> {
    return this.stat(value);
  }

  public async readFile(value: string): Promise<string> {
    const normalized = this.normalize(value);
    const content = this.files.get(normalized);
    if (content === undefined) throw new MemoryFsError("ENOENT", normalized);
    return content;
  }

  public async writeFile(
    value: string,
    data: string,
    options: ReviewWriteOptions = {},
  ): Promise<void> {
    const normalized = this.normalize(value);
    if (options.exclusive === true && (await this.stat(normalized)) !== null) {
      throw new MemoryFsError("EEXIST", normalized);
    }
    if (!this.directories.has(path.dirname(normalized))) {
      throw new MemoryFsError("ENOENT", path.dirname(normalized));
    }
    this.files.set(normalized, data);
    this.touch(normalized);
  }

  public async mkdir(
    value: string,
    options: ReviewMkdirOptions = {},
  ): Promise<void> {
    const normalized = this.normalize(value);
    if (this.directories.has(normalized)) {
      if (options.recursive === true) return;
      throw new MemoryFsError("EEXIST", normalized);
    }
    if (options.recursive === true) {
      const missing: string[] = [];
      let current = normalized;
      while (!this.directories.has(current)) {
        missing.push(current);
        const parent = path.dirname(current);
        if (parent === current) throw new MemoryFsError("ENOENT", normalized);
        current = parent;
      }
      for (const directory of missing.reverse()) {
        this.directories.add(directory);
        this.touch(directory);
      }
      return;
    }
    if (!this.directories.has(path.dirname(normalized))) {
      throw new MemoryFsError("ENOENT", path.dirname(normalized));
    }
    this.directories.add(normalized);
    this.touch(normalized);
  }

  public async readdir(value: string): Promise<readonly ReviewDirectoryEntry[]> {
    const normalized = this.normalize(value);
    if (!this.directories.has(normalized)) throw new MemoryFsError("ENOENT", normalized);
    const names = new Map<string, boolean>();
    for (const directory of this.directories) {
      if (directory !== normalized && path.dirname(directory) === normalized) {
        names.set(path.basename(directory), true);
      }
    }
    for (const file of this.files.keys()) {
      if (path.dirname(file) === normalized) names.set(path.basename(file), false);
    }
    return [...names.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, directory]) => new MemoryEntry(name, directory));
  }

  public async rename(source: string, destination: string): Promise<void> {
    const from = this.normalize(source);
    const to = this.normalize(destination);
    if ((await this.stat(to)) !== null) throw new MemoryFsError("EEXIST", to);
    if (!this.directories.has(path.dirname(to))) {
      throw new MemoryFsError("ENOENT", path.dirname(to));
    }
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.delete(from);
      this.modified.delete(from);
      this.files.set(to, content);
      this.touch(to);
      return;
    }
    if (!this.directories.has(from)) throw new MemoryFsError("ENOENT", from);
    const directories = [...this.directories]
      .filter((item) => item === from || item.startsWith(`${from}${path.sep}`))
      .sort((left, right) => left.length - right.length);
    const files = [...this.files.entries()].filter(([item]) =>
      item.startsWith(`${from}${path.sep}`),
    );
    for (const directory of directories.reverse()) this.directories.delete(directory);
    for (const [file] of files) this.files.delete(file);
    for (const directory of directories.reverse()) {
      this.directories.add(`${to}${directory.slice(from.length)}`);
    }
    for (const [file, fileContent] of files) {
      this.files.set(`${to}${file.slice(from.length)}`, fileContent);
    }
    this.touch(to);
  }

  public async rm(value: string, options: ReviewRemoveOptions = {}): Promise<void> {
    const normalized = this.normalize(value);
    if (this.files.delete(normalized)) {
      this.modified.delete(normalized);
      return;
    }
    if (!this.directories.has(normalized)) {
      if (options.force === true) return;
      throw new MemoryFsError("ENOENT", normalized);
    }
    const prefix = `${normalized}${path.sep}`;
    const hasChildren =
      [...this.directories].some((item) => item.startsWith(prefix)) ||
      [...this.files.keys()].some((item) => item.startsWith(prefix));
    if (hasChildren && options.recursive !== true) {
      throw new MemoryFsError("ENOTEMPTY", normalized);
    }
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) this.files.delete(file);
    }
    for (const directory of [...this.directories]) {
      if (directory === normalized || directory.startsWith(prefix)) {
        this.directories.delete(directory);
      }
    }
  }

  public async syncDirectory(_value: string): Promise<void> {}

  public async syncFile(_value: string): Promise<void> {}

  private normalize(value: string): string {
    return path.resolve(value);
  }

  private touch(value: string): void {
    this.clock += 1;
    this.modified.set(value, this.clock);
  }
}

class MemoryStat implements ReviewFileStat {
  public constructor(
    private readonly directory: boolean,
    public readonly mtimeMs: number,
  ) {}

  public isDirectory(): boolean {
    return this.directory;
  }
}

class MemoryEntry implements ReviewDirectoryEntry {
  public constructor(
    public readonly name: string,
    private readonly directory: boolean,
  ) {}

  public isDirectory(): boolean {
    return this.directory;
  }
}

class MemoryFsError extends Error {
  public constructor(
    public readonly code: string,
    target: string,
  ) {
    super(`${code}: ${target}`);
  }
}
