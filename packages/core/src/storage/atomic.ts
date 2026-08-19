import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  isFileSystemError,
  mkdir,
  rename,
  rm,
  stat,
  syncDirectory,
  syncFile,
  writeFile,
} from "./file-system";

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly durable?: boolean;
}

export async function atomicWriteFile(
  destination: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, data, { exclusive: true, mode: options.mode ?? 0o600 });
  if (options.durable !== false) await syncFile(temporary);

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
    if (destinationExists) await rm(backup, { force: true }).catch(() => undefined);
  } catch (error) {
    if (destinationExists) {
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  await syncDirectory(directory);
}

export async function exists(value: string): Promise<boolean> {
  return (await stat(value)) !== null;
}

function isReplaceRetryable(error: unknown): boolean {
  return (
    isFileSystemError(error) &&
    (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES")
  );
}
