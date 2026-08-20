import path from "node:path";
import {
  NodeReviewFileSystem,
  type ReviewDirectoryEntry,
  type ReviewFileStat,
  type ReviewFileSystem,
  type ReviewMkdirOptions,
  type ReviewRemoveOptions,
  type ReviewWriteOptions,
} from "../../../core/src/storage/file-system";

export interface ObsidianStat {
  readonly type: "file" | "folder";
  readonly mtime: number;
}

export interface ObsidianListedFiles {
  readonly files: readonly string[];
  readonly folders: readonly string[];
}

export interface ObsidianDataAdapter {
  exists(vaultPath: string): Promise<boolean>;
  stat(vaultPath: string): Promise<ObsidianStat | null>;
  list(vaultPath: string): Promise<ObsidianListedFiles>;
  read(vaultPath: string): Promise<string>;
  write(vaultPath: string, data: string): Promise<void>;
  mkdir(vaultPath: string): Promise<void>;
  rmdir(vaultPath: string, recursive: boolean): Promise<void>;
  remove(vaultPath: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

export class ObsidianReviewFileSystem implements ReviewFileSystem {
  private readonly vaultRoot: string;
  private readonly externalFileSystem = new NodeReviewFileSystem();

  public constructor(
    vaultRoot: string,
    private readonly adapter: ObsidianDataAdapter,
  ) {
    this.vaultRoot = path.resolve(vaultRoot);
  }

  public async realpath(value: string): Promise<string> {
    const absolute = path.resolve(value);
    if (!this.isVaultPath(absolute)) return this.externalFileSystem.realpath(absolute);
    const info = await this.stat(absolute);
    if (info === null) throw new ObsidianFileSystemError("ENOENT", value);
    return absolute;
  }

  public async stat(value: string): Promise<ReviewFileStat | null> {
    if (!this.isVaultPath(value)) return this.externalFileSystem.stat(value);
    const info = await this.adapter.stat(this.toVaultPath(value));
    return info === null ? null : new ObsidianFileStat(info);
  }

  public async lstat(value: string): Promise<ReviewFileStat | null> {
    if (!this.isVaultPath(value)) return this.externalFileSystem.lstat(value);
    return this.stat(value);
  }

  public async readFile(value: string): Promise<string> {
    if (!this.isVaultPath(value)) return this.externalFileSystem.readFile(value);
    return this.adapter.read(this.toVaultPath(value));
  }

  public async writeFile(
    value: string,
    data: string,
    options: ReviewWriteOptions = {},
  ): Promise<void> {
    if (!this.isVaultPath(value)) {
      await this.externalFileSystem.writeFile(value, data, options);
      return;
    }
    const vaultPath = this.toVaultPath(value);
    if (options.exclusive === true && (await this.adapter.exists(vaultPath))) {
      throw new ObsidianFileSystemError("EEXIST", value);
    }
    await this.adapter.write(vaultPath, data);
  }

  public async mkdir(
    value: string,
    options: ReviewMkdirOptions = {},
  ): Promise<void> {
    if (!this.isVaultPath(value)) {
      await this.externalFileSystem.mkdir(value, options);
      return;
    }
    const vaultPath = this.toVaultPath(value);
    if (options.recursive !== true) {
      if (vaultPath.length === 0) throw new ObsidianFileSystemError("EEXIST", value);
      await this.adapter.mkdir(vaultPath);
      return;
    }
    if (vaultPath.length === 0) return;

    let current = "";
    for (const segment of vaultPath.split("/")) {
      current = current.length === 0 ? segment : `${current}/${segment}`;
      const info = await this.adapter.stat(current);
      if (info?.type === "folder") continue;
      if (info !== null) throw new ObsidianFileSystemError("ENOTDIR", current);
      try {
        await this.adapter.mkdir(current);
      } catch (error) {
        const raced = await this.adapter.stat(current);
        if (raced?.type === "folder") continue;
        throw error;
      }
    }
  }

  public async readdir(value: string): Promise<readonly ReviewDirectoryEntry[]> {
    if (!this.isVaultPath(value)) return this.externalFileSystem.readdir(value);
    const listed = await this.adapter.list(this.toVaultPath(value));
    return [
      ...listed.files.map(
        (file) => new ObsidianDirectoryEntry(path.posix.basename(file), false),
      ),
      ...listed.folders.map(
        (folder) => new ObsidianDirectoryEntry(path.posix.basename(folder), true),
      ),
    ].sort((left, right) => left.name.localeCompare(right.name));
  }

  public async rename(source: string, destination: string): Promise<void> {
    const sourceInVault = this.isVaultPath(source);
    const destinationInVault = this.isVaultPath(destination);
    if (!sourceInVault && !destinationInVault) {
      await this.externalFileSystem.rename(source, destination);
      return;
    }
    if (sourceInVault && destinationInVault) {
      await this.adapter.rename(
        this.toVaultPath(source),
        this.toVaultPath(destination),
      );
      return;
    }

    const sourceInfo = await this.stat(source);
    if (sourceInfo === null) throw new ObsidianFileSystemError("ENOENT", source);
    if (sourceInfo.isDirectory()) throw new ObsidianFileSystemError("EXDEV", source);
    await this.writeFile(destination, await this.readFile(source), { exclusive: true });
    await this.rm(source);
  }

  public async rm(
    value: string,
    options: ReviewRemoveOptions = {},
  ): Promise<void> {
    if (!this.isVaultPath(value)) {
      await this.externalFileSystem.rm(value, options);
      return;
    }
    const vaultPath = this.toVaultPath(value);
    const info = await this.adapter.stat(vaultPath);
    if (info === null) {
      if (options.force === true) return;
      throw new ObsidianFileSystemError("ENOENT", value);
    }
    if (info.type === "folder") {
      await this.adapter.rmdir(vaultPath, options.recursive ?? false);
    } else {
      await this.adapter.remove(vaultPath);
    }
  }

  public async syncFile(value: string): Promise<void> {
    if (!this.isVaultPath(value)) await this.externalFileSystem.syncFile(value);
  }

  public async syncDirectory(value: string): Promise<void> {
    if (!this.isVaultPath(value)) await this.externalFileSystem.syncDirectory(value);
  }

  private isVaultPath(value: string): boolean {
    const relative = path.relative(this.vaultRoot, path.resolve(value));
    return (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  private toVaultPath(value: string): string {
    const relative = path.relative(this.vaultRoot, path.resolve(value));
    if (!this.isVaultPath(value)) {
      throw new ObsidianFileSystemError("EACCES", value);
    }
    return relative.split(path.sep).join("/");
  }
}

class ObsidianFileStat implements ReviewFileStat {
  public readonly mtimeMs: number;

  public constructor(private readonly info: ObsidianStat) {
    this.mtimeMs = info.mtime;
  }

  public isDirectory(): boolean {
    return this.info.type === "folder";
  }
}

class ObsidianDirectoryEntry implements ReviewDirectoryEntry {
  public constructor(
    public readonly name: string,
    private readonly directory: boolean,
  ) {}

  public isDirectory(): boolean {
    return this.directory;
  }
}

class ObsidianFileSystemError extends Error {
  public override readonly name = "ObsidianFileSystemError";

  public constructor(
    public readonly code: string,
    value: string,
  ) {
    super(`${code}: ${value}`);
  }
}
