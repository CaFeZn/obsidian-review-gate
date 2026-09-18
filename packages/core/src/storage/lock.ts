import { mkdir, readFile, rm, stat, writeFile } from "./file-system";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ReviewError, errorMessage } from "../model/errors";

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly retryDelayMs?: number;
  readonly signal?: AbortSignal;
}

export interface ReviewLock {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

interface LockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly createdAt: string;
}

type LockIoPhase = "owner-read" | "owner-write" | "owner-cleanup" | "release" | "stale-cleanup";

type LockIoFailure = Readonly<{ error: unknown; retryError?: unknown }>;

const activeLockTokens = new Map<string, string>();

export async function acquireDirectoryLock(
  lockPath: string,
  options: LockOptions = {},
): Promise<ReviewLock> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 120_000;
  const retryDelayMs = options.retryDelayMs ?? 40;
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(16).toString("hex");

  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    throwIfAborted(options.signal);
    try {
      await mkdir(lockPath);
      const owner: LockOwner = {
        pid: process.pid,
        hostname: os.hostname(),
        token,
        createdAt: new Date().toISOString(),
      };
      try {
        await writeFile(path.join(lockPath, "owner.rgdata"), JSON.stringify(owner), {
          exclusive: true,
          mode: 0o600,
        });
      } catch (error) {
        const ownerWriteError = error instanceof Error ? error : new Error(String(error));
        // A directory without owner metadata must never be left behind by a failed
        // acquisition. Otherwise every future caller would wait for stale timeout.
        let cleanupError: unknown;
        try {
          await removeLockDirectory(lockPath, "owner-cleanup", retryDelayMs);
        } catch (cleanupFailure) {
          cleanupError =
            cleanupFailure instanceof Error ? cleanupFailure : new Error(String(cleanupFailure));
        }
        throw lockIoError("owner-write", lockPath, {
          error: ownerWriteError,
          ...(cleanupError === undefined ? {} : { retryError: cleanupError }),
        });
      }
      activeLockTokens.set(lockPath, token);
      let released = false;
      return {
        path: lockPath,
        token,
        async release(): Promise<void> {
          if (released) return;
          try {
            let current: LockOwner | null;
            try {
              current = await readOwner(lockPath);
            } catch (error) {
              const ownerReadError = error instanceof Error ? error : new Error(String(error));
              throw lockIoError("owner-read", lockPath, { error: ownerReadError });
            }
            if (current?.token === token) {
              await removeLockDirectory(lockPath, "release", retryDelayMs);
            }
            released = true;
          } finally {
            if (activeLockTokens.get(lockPath) === token) activeLockTokens.delete(lockPath);
          }
        },
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      let stale: boolean;
      try {
        stale = await lockIsStale(lockPath, staleMs);
      } catch (inspectionError) {
        if (!(inspectionError instanceof Error)) throw inspectionError;
        if (isRetryableFileSystemError(inspectionError) && Date.now() < deadline) {
          await delay(retryDelayMs, options.signal);
          continue;
        }
        throw lockIoError("owner-read", lockPath, { error: inspectionError });
      }
      if (stale) {
        await removeLockDirectory(lockPath, "stale-cleanup", retryDelayMs);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ReviewError("LOCK_TIMEOUT", "Timed out waiting for the review lock.", {
          lockPath,
          timeoutMs,
        });
      }
      await delay(retryDelayMs, options.signal);
    }
  }
}

export async function withDirectoryLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  const lock = await acquireDirectoryLock(lockPath, options);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
  const owner = await readOwner(lockPath);
  if (owner === null) {
    // mkdir() and owner.rgdata creation are two filesystem operations. A competing
    // process can observe the directory in that tiny window. Treating a missing
    // owner file as immediately stale lets the competitor delete a live lock and
    // defeats revision-based concurrency control. Only reclaim an ownerless lock
    // after the lock directory itself is old enough.
    try {
      const lockStat = await stat(lockPath);
      return lockStat !== null && Date.now() - lockStat.mtimeMs > staleMs;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }
  const age = Date.now() - Date.parse(owner.createdAt);
  if (!Number.isFinite(age) || age > staleMs) return true;
  if (owner.hostname !== os.hostname()) return false;
  if (owner.pid === process.pid) return activeLockTokens.get(lockPath) !== owner.token;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return isNodeError(error) && error.code === "ESRCH";
  }
}

async function removeLockDirectory(
  lockPath: string,
  phase: LockIoPhase,
  retryDelayMs: number,
): Promise<void> {
  let firstError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await rm(lockPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      firstError ??= error;
      if (attempt === 0 && isRetryableFileSystemError(error)) {
        await delay(retryDelayMs, undefined);
        continue;
      }
      throw lockIoError(phase, lockPath, {
        error: firstError,
        ...(error === firstError ? {} : { retryError: error }),
      });
    }
  }
}

function lockIoError(
  phase: LockIoPhase,
  lockPath: string,
  failure: LockIoFailure,
): ReviewError {
  const primaryMessage = errorMessage(failure.error);
  const details = {
    lockPath,
    phase,
    error: primaryMessage,
    ...(failure.retryError === undefined
      ? {}
      : { retryError: errorMessage(failure.retryError) }),
  };
  const options = failure.error instanceof Error ? { cause: failure.error } : undefined;
  return new ReviewError(
    "IO_ERROR",
    `Review lock ${phase} failed at ${lockPath}: ${primaryMessage}`,
    details,
    options,
  );
}

function isRetryableFileSystemError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    ["EACCES", "EBUSY", "ENOTEMPTY", "EPERM", "UNKNOWN"].includes(error.code ?? "")
  );
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(lockPath, "owner.rgdata"), "utf8"),
    );
    if (!isLockOwner(parsed)) return null;
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!isRecord(value)) return false;
  return (
    typeof value["pid"] === "number" &&
    typeof value["hostname"] === "string" &&
    typeof value["token"] === "string" &&
    typeof value["createdAt"] === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Operation aborted.");
  }
}

async function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
