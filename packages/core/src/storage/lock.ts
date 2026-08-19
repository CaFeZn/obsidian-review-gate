import { mkdir, readFile, rm, stat, writeFile } from "./file-system";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ReviewError } from "../model/errors";

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
        await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), {
          exclusive: true,
          mode: 0o600,
        });
      } catch (error) {
        // A directory without owner metadata must never be left behind by a failed
        // acquisition. Otherwise every future caller would wait for stale timeout.
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return {
        path: lockPath,
        token,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          const current = await readOwner(lockPath);
          if (current?.token === token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (await lockIsStale(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
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
    // mkdir() and owner.json creation are two filesystem operations. A competing
    // process can observe the directory in that tiny window. Treating a missing
    // owner file as immediately stale lets the competitor delete a live lock and
    // defeats revision-based concurrency control. Only reclaim an ownerless lock
    // after the lock directory itself is old enough.
    try {
      const lockStat = await stat(lockPath);
      return lockStat !== null && Date.now() - lockStat.mtimeMs > staleMs;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }
  const age = Date.now() - Date.parse(owner.createdAt);
  if (!Number.isFinite(age) || age > staleMs) return true;
  if (owner.hostname !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(lockPath, "owner.json"), "utf8"),
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
