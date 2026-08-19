import {
  mkdir,
  open,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly durable?: boolean;
}

export async function atomicWriteFile(
  destination: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporary, "wx", options.mode ?? 0o600);
  try {
    await handle.writeFile(data);
    if (options.durable !== false) await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await replacePath(temporary, destination);
    if (options.durable !== false) await fsyncDirectory(path.dirname(destination));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Atomically installs source at destination on POSIX. On Windows, where rename
 * over an existing destination can fail, it uses a same-directory backup and
 * restores it if the replacement fails.
 */
export async function replacePath(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (!isReplaceRetryable(error)) throw error;
  }

  const backup = `${destination}.replace-backup-${process.pid}-${randomBytes(5).toString("hex")}`;
  const destinationExists = await exists(destination);
  if (destinationExists) await rename(destination, backup);
  try {
    await rename(source, destination);
    if (destinationExists) await unlink(backup).catch(() => undefined);
  } catch (error) {
    if (destinationExists) {
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Windows and some virtual filesystems do not permit opening directories.
    // File fsync + same-directory rename remains the strongest portable path.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function exists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isReplaceRetryable(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES")
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
