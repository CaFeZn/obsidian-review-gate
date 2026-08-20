import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  open as nodeOpen,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rm as nodeRm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from "node:fs/promises";

export interface ReviewFileStat {
  readonly mtimeMs: number;
  isDirectory(): boolean;
}

export interface ReviewDirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

export interface ReviewMkdirOptions {
  readonly recursive?: boolean;
}

export interface ReviewWriteOptions {
  readonly exclusive?: boolean;
  readonly mode?: number;
}

export interface ReviewRemoveOptions {
  readonly recursive?: boolean;
  readonly force?: boolean;
}

export interface ReviewFileSystem {
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<ReviewFileStat | null>;
  lstat(value: string): Promise<ReviewFileStat | null>;
  readFile(value: string): Promise<string>;
  writeFile(value: string, data: string, options?: ReviewWriteOptions): Promise<void>;
  mkdir(value: string, options?: ReviewMkdirOptions): Promise<void>;
  readdir(value: string): Promise<readonly ReviewDirectoryEntry[]>;
  rename(source: string, destination: string): Promise<void>;
  rm(value: string, options?: ReviewRemoveOptions): Promise<void>;
  syncFile(value: string): Promise<void>;
  syncDirectory(value: string): Promise<void>;
}

export function installReviewFileSystem(fileSystem: ReviewFileSystem): () => void {
  const previous = activeFileSystem;
  let restored = false;
  activeFileSystem = fileSystem;
  return () => {
    if (restored) return;
    restored = true;
    if (activeFileSystem === fileSystem) activeFileSystem = previous;
  };
}

export async function realpath(value: string): Promise<string> {
  return activeFileSystem.realpath(value);
}

export async function stat(value: string): Promise<ReviewFileStat | null> {
  return activeFileSystem.stat(value);
}

export async function lstat(value: string): Promise<ReviewFileStat | null> {
  return activeFileSystem.lstat(value);
}

export async function readFile(value: string, _encoding: "utf8" = "utf8"): Promise<string> {
  return activeFileSystem.readFile(value);
}

export async function writeFile(
  value: string,
  data: string,
  options: ReviewWriteOptions = {},
): Promise<void> {
  await activeFileSystem.writeFile(value, data, options);
}

export async function mkdir(
  value: string,
  options: ReviewMkdirOptions = {},
): Promise<void> {
  await activeFileSystem.mkdir(value, options);
}

export async function readdir(
  value: string,
  _options: { readonly withFileTypes: true },
): Promise<readonly ReviewDirectoryEntry[]> {
  return activeFileSystem.readdir(value);
}

export async function rename(source: string, destination: string): Promise<void> {
  await activeFileSystem.rename(source, destination);
}

export async function rm(
  value: string,
  options: ReviewRemoveOptions = {},
): Promise<void> {
  await activeFileSystem.rm(value, options);
}

export async function syncFile(value: string): Promise<void> {
  await activeFileSystem.syncFile(value);
}

export async function syncDirectory(value: string): Promise<void> {
  await activeFileSystem.syncDirectory(value);
}

export function isFileSystemError(error: unknown): error is Error & { readonly code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

export class NodeReviewFileSystem implements ReviewFileSystem {
  public async realpath(value: string): Promise<string> {
    return nodeRealpath(value);
  }

  public async stat(value: string): Promise<ReviewFileStat | null> {
    try {
      return await nodeStat(value);
    } catch (error) {
      if (isFileSystemError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  public async lstat(value: string): Promise<ReviewFileStat | null> {
    try {
      return await nodeLstat(value);
    } catch (error) {
      if (isFileSystemError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  public async readFile(value: string): Promise<string> {
    return nodeReadFile(value, "utf8");
  }

  public async writeFile(
    value: string,
    data: string,
    options: ReviewWriteOptions = {},
  ): Promise<void> {
    await nodeWriteFile(value, data, {
      encoding: "utf8",
      flag: options.exclusive === true ? "wx" : "w",
      mode: options.mode ?? 0o600,
    });
  }

  public async mkdir(value: string, options: ReviewMkdirOptions = {}): Promise<void> {
    await nodeMkdir(value, { recursive: options.recursive ?? false });
  }

  public async readdir(value: string): Promise<readonly ReviewDirectoryEntry[]> {
    const entries = await nodeReaddir(value, { withFileTypes: true });
    return entries.map((entry) => new NodeDirectoryEntry(entry.name, entry.isDirectory()));
  }

  public async rename(source: string, destination: string): Promise<void> {
    await nodeRename(source, destination);
  }

  public async rm(value: string, options: ReviewRemoveOptions = {}): Promise<void> {
    await nodeRm(value, {
      recursive: options.recursive ?? false,
      force: options.force ?? false,
    });
  }

  public async syncFile(value: string): Promise<void> {
    const handle = await nodeOpen(value, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async syncDirectory(value: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof nodeOpen>> | null = null;
    try {
      handle = await nodeOpen(value, "r");
      await handle.sync();
    } catch (error) {
      if (
        isFileSystemError(error) &&
        ["EACCES", "EBADF", "EISDIR", "EPERM"].includes(error.code)
      ) {
        return;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
}

class NodeDirectoryEntry implements ReviewDirectoryEntry {
  public constructor(
    public readonly name: string,
    private readonly directory: boolean,
  ) {}

  public isDirectory(): boolean {
    return this.directory;
  }
}

let activeFileSystem: ReviewFileSystem = new NodeReviewFileSystem();
