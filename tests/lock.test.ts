import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  acquireDirectoryLock,
  installReviewFileSystem,
  NodeReviewFileSystem,
  ReviewError,
  type ReviewLock,
  type ReviewRemoveOptions,
  type ReviewWriteOptions,
} from "../packages/core/src/index";
import { cleanupVault, createVault } from "./helpers";

test("directory lock retries when owner metadata is transiently unreadable", async () => {
  // Given: an active lock whose owner file returns one transient Windows access error.
  const root = await createVault();
  const lockPath = path.join(root, "review.lock");
  const fileSystem = new TransientOwnerReadFileSystem();
  const restore = installReviewFileSystem(fileSystem);
  let firstLock: ReviewLock | null = null;
  let secondLock: ReviewLock | null = null;

  try {
    firstLock = await acquireDirectoryLock(lockPath);
    const firstToken = firstLock.token;

    // When: a contender inspects the active lock, then retries after it is released.
    const waitingLock = acquireDirectoryLock(lockPath, {
      retryDelayMs: 1,
      timeoutMs: 1_000,
    }).then(
      (lock): { readonly lock: ReviewLock } => ({ lock }),
      (error: unknown): { readonly error: unknown } => ({ error }),
    );
    await fileSystem.ownerReadAttempted;
    await firstLock.release();
    firstLock = null;
    const waitingResult = await waitingLock;
    if ("error" in waitingResult) throw waitingResult.error;
    secondLock = waitingResult.lock;

    // Then: the transient read error does not escape and ownership transfers normally.
    assert.notEqual(secondLock.token, firstToken);
  } finally {
    await secondLock?.release();
    await firstLock?.release();
    restore();
    await cleanupVault(root);
  }
});

test("directory lock reports persistent owner read failures instead of lock timeout", async () => {
  // Given: an active lock whose owner metadata remains inaccessible.
  const root = await createVault();
  const lockPath = path.join(root, "review.lock");
  const fileSystem = new FaultInjectingFileSystem();
  const restore = installReviewFileSystem(fileSystem);
  let activeLock: ReviewLock | null = null;

  try {
    activeLock = await acquireDirectoryLock(lockPath);
    fileSystem.ownerReadFailures = 100;

    // When: another caller reaches its wait deadline while owner reads keep failing.
    const blocked = acquireDirectoryLock(lockPath, { retryDelayMs: 1, timeoutMs: 10 });

    // Then: the first actionable I/O phase and lock path are preserved.
    await assert.rejects(blocked, isLockIoError("owner-read", lockPath));
  } finally {
    fileSystem.ownerReadFailures = 0;
    await activeLock?.release();
    restore();
    await cleanupVault(root);
  }
});

test("directory lock reports stale cleanup failures instead of retrying past them", async () => {
  // Given: a stale lock whose directory removal fails twice.
  const root = await createVault();
  const lockPath = path.join(root, "review.lock");
  const fileSystem = new FaultInjectingFileSystem();
  await fileSystem.mkdir(lockPath, { recursive: true });
  await fileSystem.writeFile(
    path.join(lockPath, "owner.rgdata"),
    JSON.stringify({ pid: process.pid, hostname: "localhost", token: "stale", createdAt: "invalid" }),
  );
  fileSystem.removeFailures = 2;
  const restore = installReviewFileSystem(fileSystem);

  try {
    // When: a caller attempts to reclaim the stale directory.
    const blocked = acquireDirectoryLock(lockPath, { retryDelayMs: 1, timeoutMs: 50 });

    // Then: stale cleanup reports the original filesystem failure immediately.
    await assert.rejects(blocked, isLockIoError("stale-cleanup", lockPath));
  } finally {
    restore();
    await cleanupVault(root);
  }
});

test("directory lock release can retry after removal fails", async () => {
  // Given: an acquired lock whose first release exhausts two removal attempts.
  const root = await createVault();
  const lockPath = path.join(root, "review.lock");
  const fileSystem = new FaultInjectingFileSystem();
  const restore = installReviewFileSystem(fileSystem);

  try {
    const lock = await acquireDirectoryLock(lockPath);
    fileSystem.removeFailures = 2;

    // When: release fails, then the same owner retries release.
    await assert.rejects(lock.release(), isLockIoError("release", lockPath));
    await lock.release();

    // Then: the retry removes the lock instead of returning early.
    assert.equal(await fileSystem.stat(lockPath), null);
  } finally {
    restore();
    await cleanupVault(root);
  }
});

test("directory lock reclaims same-process residue after release cleanup fails", async () => {
  const root = await createVault();
  const lockPath = path.join(root, "review.lock");
  const fileSystem = new FaultInjectingFileSystem();
  const restore = installReviewFileSystem(fileSystem);
  let firstLock: ReviewLock | null = null;
  let nextLock: ReviewLock | null = null;

  try {
    firstLock = await acquireDirectoryLock(lockPath);
    fileSystem.removeFailures = 2;
    const failedRelease = firstLock.release();
    await assert.rejects(failedRelease, isLockIoError("release", lockPath));

    nextLock = await acquireDirectoryLock(lockPath, {
      retryDelayMs: 1,
      staleMs: 120_000,
      timeoutMs: 20,
    });

    assert.notEqual(nextLock.token, firstLock.token);
  } finally {
    fileSystem.removeFailures = 0;
    await nextLock?.release();
    await firstLock?.release();
    restore();
    await cleanupVault(root);
  }
});

test("directory lock removes ownerless residue after owner metadata write fails", async () => {
  // Given: owner metadata creation and the first cleanup attempt fail.
  const root = await createVault();
  const lockPath = path.join(root, "review.lock");
  const fileSystem = new FaultInjectingFileSystem();
  fileSystem.ownerWriteFailures = 1;
  fileSystem.removeFailures = 1;
  const restore = installReviewFileSystem(fileSystem);

  try {
    // When: acquisition cannot persist its owner metadata.
    const blocked = acquireDirectoryLock(lockPath, { retryDelayMs: 1 });

    // Then: the owner-write error remains visible and cleanup leaves no lock directory.
    await assert.rejects(blocked, isLockIoError("owner-write", lockPath));
    assert.equal(await fileSystem.stat(lockPath), null);
  } finally {
    restore();
    await cleanupVault(root);
  }
});

class TransientOwnerReadFileSystem extends NodeReviewFileSystem {
  public readonly ownerReadAttempted: Promise<void>;
  private resolveOwnerRead: (() => void) | undefined;
  private injectOwnerReadError = true;

  public constructor() {
    super();
    this.ownerReadAttempted = new Promise((resolve) => {
      this.resolveOwnerRead = resolve;
    });
  }

  public override async readFile(value: string): Promise<string> {
    if (this.injectOwnerReadError && path.basename(value) === "owner.rgdata") {
      this.injectOwnerReadError = false;
      this.resolveOwnerRead?.();
      throw new TransientOwnerReadError();
    }
    return super.readFile(value);
  }
}

class TransientOwnerReadError extends Error {
  public readonly code = "UNKNOWN";

  public constructor() {
    super("Owner metadata is transiently unreadable.");
    this.name = "TransientOwnerReadError";
  }
}

class FaultInjectingFileSystem extends NodeReviewFileSystem {
  public ownerReadFailures = 0;
  public ownerWriteFailures = 0;
  public removeFailures = 0;

  public override async readFile(value: string): Promise<string> {
    if (path.basename(value) === "owner.rgdata" && this.ownerReadFailures > 0) {
      this.ownerReadFailures -= 1;
      throw new InjectedFileSystemError("EPERM", "owner metadata read failed");
    }
    return super.readFile(value);
  }

  public override async writeFile(
    value: string,
    data: string,
    options: ReviewWriteOptions = {},
  ): Promise<void> {
    if (path.basename(value) === "owner.rgdata" && this.ownerWriteFailures > 0) {
      this.ownerWriteFailures -= 1;
      throw new InjectedFileSystemError("EPERM", "owner metadata write failed");
    }
    await super.writeFile(value, data, options);
  }

  public override async rm(value: string, options: ReviewRemoveOptions = {}): Promise<void> {
    if (this.removeFailures > 0) {
      this.removeFailures -= 1;
      throw new InjectedFileSystemError("EPERM", "lock directory removal failed");
    }
    await super.rm(value, options);
  }
}

class InjectedFileSystemError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InjectedFileSystemError";
  }
}

function isLockIoError(phase: string, lockPath: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof ReviewError &&
    error.code === "IO_ERROR" &&
    error.details?.["phase"] === phase &&
    error.details["lockPath"] === lockPath &&
    error.message.includes(lockPath);
}
