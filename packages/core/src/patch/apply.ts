import {
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Review, ReviewChange, ReviewConflict } from "../model/review";
import { ReviewError, errorMessage } from "../model/errors";
import { sha256 } from "../model/hash";
import { assertTransition } from "../model/state-machine";
import { inspectReviewConflicts } from "../conflict/check";
import { resolveSafeTarget, isPathInside } from "../path/safe-path";
import { ReviewStore } from "../storage/review-store";
import { atomicWriteFile, exists, fsyncDirectory } from "../storage/atomic";
import { lockDirectory, transactionDirectory, trashTargetPath } from "../storage/layout";
import { withDirectoryLock } from "../storage/lock";

export interface ApproveOptions {
  readonly force?: boolean;
  readonly actor?: string;
  readonly expectedRevision?: number;
  readonly lockTimeoutMs?: number;
}

export interface ApplyResult {
  readonly review: Review;
  readonly transactionId: string;
  /** True when the target commit is durable but backup housekeeping must be retried at startup. */
  readonly maintenancePending?: boolean;
}

type TransactionPhase = "prepared" | "applying" | "committed" | "rolled-back";

export interface TransactionEntry {
  readonly changeId: string;
  readonly operation: ReviewChange["operation"];
  readonly target: string;
  readonly targetPath: string;
  readonly originalTargetExisted: boolean;
  readonly stagePath: string | null;
  readonly backupPath: string;
  readonly newTarget?: string;
  readonly newTargetPath?: string;
  readonly originalNewTargetExisted?: boolean;
  readonly newTargetBackupPath?: string;
  readonly trashPath?: string;
}

export interface TransactionJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly reviewId: string;
  readonly createdAt: string;
  readonly phase: TransactionPhase;
  readonly committedChangeIds: readonly string[];
  readonly entries: readonly TransactionEntry[];
}

export async function approveReview(
  store: ReviewStore,
  reviewId: string,
  options: ApproveOptions = {},
): Promise<ApplyResult> {
  return withDirectoryLock(
    lockDirectory(store.vaultRoot, reviewId),
    async () => {
      let located = await store.loadLocated(reviewId);
      let review = located.review;
      if (located.location !== "pending") {
        throw new ReviewError(
          "INVALID_STATE_TRANSITION",
          `Review is already finalized with status ${review.status}.`,
          { reviewId, status: review.status },
        );
      }
      if (options.expectedRevision !== undefined && review.revision !== options.expectedRevision) {
        throw new ReviewError(
          "REVISION_CONFLICT",
          `Expected revision ${options.expectedRevision}, found ${review.revision}.`,
          {
            reviewId,
            expectedRevision: options.expectedRevision,
            actualRevision: review.revision,
          },
        );
      }
      if (review.status !== "pending" && review.status !== "conflicted") {
        throw new ReviewError(
          "INVALID_STATE_TRANSITION",
          `Review with status ${review.status} cannot be approved.`,
          { reviewId, status: review.status },
        );
      }

      const initialInspection = await inspectReviewConflicts(store.vaultRoot, review);
      if (initialInspection.conflicts.length > 0 && options.force !== true) {
        review = await persistAuthoritativeConflict(store, review, initialInspection.conflicts);
        throw new ReviewError(
          "REVIEW_CONFLICT",
          "Target state changed since the review was created; direct apply was refused.",
          {
            reviewId,
            revision: review.revision,
            conflicts: initialInspection.conflicts,
          },
        );
      }

      const transactionId = `${review.id}-${Date.now()}-${randomBytes(5).toString("hex")}`;
      const txDirectory = transactionDirectory(store.vaultRoot, transactionId);
      await mkdir(txDirectory, { recursive: false });
      let journal = await prepareTransaction(store.vaultRoot, review, transactionId, txDirectory);

      try {
        // Authoritative all-file validation is repeated after staging and before
        // the first target mutation. Watcher state is never consulted here.
        const authoritative = await inspectReviewConflicts(store.vaultRoot, review);
        if (authoritative.conflicts.length > 0 && options.force !== true) {
          review = await persistAuthoritativeConflict(store, review, authoritative.conflicts);
          throw new ReviewError(
            "REVIEW_CONFLICT",
            "Target state changed during apply staging; no target was written.",
            { reviewId, conflicts: authoritative.conflicts },
          );
        }

        journal = { ...journal, phase: "applying" };
        await writeJournal(txDirectory, journal);
        for (const entry of journal.entries) {
          if (options.force !== true) {
            await verifyEntryStillMatches(store.vaultRoot, review, entry);
          }
          await commitEntry(entry);
          journal = {
            ...journal,
            committedChangeIds: [...journal.committedChangeIds, entry.changeId],
          };
          await writeJournal(txDirectory, journal);
        }

        await verifyAppliedReview(review, journal.entries);
        const approved = approvedReview(review, options);
        await store.archive(approved);
        journal = { ...journal, phase: "committed" };
        await writeJournal(txDirectory, journal);
        await preserveTransactionBackups(store.vaultRoot, review.id, journal.entries);
        await rm(txDirectory, { recursive: true, force: true });
        return { review: approved, transactionId };
      } catch (error) {
        // The durable review state is checked before rollback. A failure after
        // archive (for example while cleaning transaction files) must never undo
        // an already approved commit.
        try {
          located = await store.loadLocated(reviewId);
          if (located.review.status === "approved") {
            try {
              await preserveTransactionBackups(
                store.vaultRoot,
                review.id,
                journal.entries,
              );
              await rm(txDirectory, { recursive: true, force: true });
              return { review: located.review, transactionId };
            } catch {
              // Keep the committed journal and backups for startup recovery.
              return {
                review: located.review,
                transactionId,
                maintenancePending: true,
              };
            }
          }
        } catch {
          // The original apply error remains authoritative when state cannot load.
        }

        const isConflict =
          error instanceof ReviewError && error.code === "REVIEW_CONFLICT";
        if (isConflict && journal.committedChangeIds.length === 0) {
          await rm(txDirectory, { recursive: true, force: true });
          throw error;
        }

        const rollbackErrors = await rollbackEntries([...journal.entries].reverse());
        journal = { ...journal, phase: "rolled-back" };
        await writeJournal(txDirectory, journal).catch(() => undefined);

        if (isConflict && rollbackErrors.length === 0) {
          const inspection = await inspectReviewConflicts(store.vaultRoot, review);
          if (inspection.conflicts.length > 0) {
            await persistAuthoritativeConflict(store, review, inspection.conflicts);
          }
          await rm(txDirectory, { recursive: true, force: true });
          throw new ReviewError(
            "REVIEW_CONFLICT",
            "A target changed during multi-file commit; completed writes were rolled back.",
            { reviewId, transactionId, conflicts: inspection.conflicts },
            { cause: error },
          );
        }

        const failedReview: Review = {
          ...review,
          revision: review.revision + 1,
          updatedAt: new Date().toISOString(),
          partialFailure: {
            transactionId,
            failedAt: new Date().toISOString(),
            message: errorMessage(error),
            committedChangeIds: journal.committedChangeIds,
            rollbackErrors,
          },
        };
        await store.save(failedReview).catch(() => undefined);
        if (rollbackErrors.length === 0) {
          await rm(txDirectory, { recursive: true, force: true });
        }
        throw new ReviewError(
          "APPLY_FAILED",
          rollbackErrors.length === 0
            ? `Apply failed and all target mutations were rolled back: ${errorMessage(error)}`
            : `Apply failed; rollback also reported errors: ${errorMessage(error)}`,
          { reviewId, transactionId, rollbackErrors },
          { cause: error },
        );
      }
    },
    options.lockTimeoutMs === undefined ? undefined : { timeoutMs: options.lockTimeoutMs },
  );
}

async function prepareTransaction(
  vaultRoot: string,
  review: Review,
  transactionId: string,
  txDirectory: string,
): Promise<TransactionJournal> {
  const entries: TransactionEntry[] = [];
  for (const change of review.changes) {
    const target = await resolveSafeTarget(vaultRoot, change.target);
    const backupPath = path.join(txDirectory, "backups", `${change.id}-target`);
    let stagePath: string | null = null;
    if (change.proposalContent !== null) {
      stagePath = path.join(txDirectory, "staged", `${change.id}.new`);
      await atomicWriteFile(stagePath, change.proposalContent);
    }
    const entry: TransactionEntry = {
      changeId: change.id,
      operation: change.operation,
      target: change.target,
      targetPath: target.absolutePath,
      originalTargetExisted: target.exists,
      stagePath,
      backupPath,
    };
    const mutable = entry as Mutable<TransactionEntry>;
    if (change.operation === "delete") {
      mutable.trashPath = trashTargetPath(vaultRoot, review.id, change.target);
    }
    if (change.operation === "rename") {
      if (change.newTarget === undefined) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `Rename change ${change.id} has no newTarget.`,
          { changeId: change.id },
        );
      }
      const destination = await resolveSafeTarget(vaultRoot, change.newTarget);
      mutable.newTarget = change.newTarget;
      mutable.newTargetPath = destination.absolutePath;
      mutable.originalNewTargetExisted = destination.exists;
      mutable.newTargetBackupPath = path.join(
        txDirectory,
        "backups",
        `${change.id}-new-target`,
      );
    }
    entries.push(entry);
  }
  const journal: TransactionJournal = {
    schemaVersion: 1,
    transactionId,
    reviewId: review.id,
    createdAt: new Date().toISOString(),
    phase: "prepared",
    committedChangeIds: [],
    entries,
  };
  await writeJournal(txDirectory, journal);
  return journal;
}

async function verifyEntryStillMatches(
  vaultRoot: string,
  review: Review,
  entry: TransactionEntry,
): Promise<void> {
  const change = review.changes.find((candidate) => candidate.id === entry.changeId);
  if (change === undefined) throw new Error(`Missing change ${entry.changeId}.`);
  const target = await resolveSafeTarget(vaultRoot, entry.target);
  const current = target.exists ? await readFile(target.absolutePath, "utf8") : null;
  const currentHash = current === null ? null : sha256(current);
  if (change.operation === "create") {
    if (target.exists) {
      throw new ReviewError("REVIEW_CONFLICT", `Create target appeared: ${change.target}`, {
        changeId: change.id,
      });
    }
  } else if (currentHash !== change.baseHash) {
    throw new ReviewError("REVIEW_CONFLICT", `Target changed during commit: ${change.target}`, {
      changeId: change.id,
      expectedHash: change.baseHash,
      currentHash,
    });
  }
  if (change.operation === "rename" && change.newTarget !== undefined) {
    const destination = await resolveSafeTarget(vaultRoot, change.newTarget);
    if (destination.exists) {
      throw new ReviewError(
        "REVIEW_CONFLICT",
        `Rename destination appeared during commit: ${change.newTarget}`,
        { changeId: change.id },
      );
    }
  }
}

async function commitEntry(entry: TransactionEntry): Promise<void> {
  switch (entry.operation) {
    case "create":
    case "modify": {
      if (entry.stagePath === null) throw new Error(`No staged proposal for ${entry.changeId}.`);
      await mkdir(path.dirname(entry.targetPath), { recursive: true });
      if (await exists(entry.targetPath)) {
        await mkdir(path.dirname(entry.backupPath), { recursive: true });
        await rename(entry.targetPath, entry.backupPath);
      }
      await rename(entry.stagePath, entry.targetPath);
      await fsyncDirectory(path.dirname(entry.targetPath));
      return;
    }
    case "delete": {
      if (!(await exists(entry.targetPath))) return;
      if (entry.trashPath === undefined) throw new Error(`No trash path for ${entry.changeId}.`);
      await mkdir(path.dirname(entry.trashPath), { recursive: true });
      if (await exists(entry.trashPath)) {
        throw new Error(`Delete trash destination already exists: ${entry.trashPath}`);
      }
      await rename(entry.targetPath, entry.trashPath);
      await fsyncDirectory(path.dirname(entry.targetPath));
      return;
    }
    case "rename": {
      if (
        entry.stagePath === null ||
        entry.newTargetPath === undefined ||
        entry.newTargetBackupPath === undefined
      ) {
        throw new Error(`Incomplete rename plan for ${entry.changeId}.`);
      }
      await mkdir(path.dirname(entry.backupPath), { recursive: true });
      if (await exists(entry.targetPath)) await rename(entry.targetPath, entry.backupPath);
      if (await exists(entry.newTargetPath)) {
        await mkdir(path.dirname(entry.newTargetBackupPath), { recursive: true });
        await rename(entry.newTargetPath, entry.newTargetBackupPath);
      }
      await mkdir(path.dirname(entry.newTargetPath), { recursive: true });
      await rename(entry.stagePath, entry.newTargetPath);
      await fsyncDirectory(path.dirname(entry.targetPath));
      await fsyncDirectory(path.dirname(entry.newTargetPath));
      return;
    }
  }
}

async function verifyAppliedReview(
  review: Review,
  entries: readonly TransactionEntry[],
): Promise<void> {
  for (const change of review.changes) {
    const entry = entries.find((candidate) => candidate.changeId === change.id);
    if (entry === undefined) throw new Error(`No transaction entry for ${change.id}.`);
    if (change.operation === "delete") {
      if (await exists(entry.targetPath)) {
        throw new Error(`Delete verification failed for ${change.target}.`);
      }
      continue;
    }
    const resultPath =
      change.operation === "rename" ? entry.newTargetPath : entry.targetPath;
    if (resultPath === undefined || !(await exists(resultPath))) {
      throw new Error(`Result file is missing for ${change.id}.`);
    }
    const content = await readFile(resultPath, "utf8");
    if (change.proposalContent === null || sha256(content) !== sha256(change.proposalContent)) {
      throw new Error(`Result hash verification failed for ${change.id}.`);
    }
    if (change.operation === "rename" && (await exists(entry.targetPath))) {
      throw new Error(`Rename source still exists for ${change.id}.`);
    }
  }
}

function approvedReview(review: Review, options: ApproveOptions): Review {
  assertTransition(review.status, "approved");
  const now = new Date().toISOString();
  const changes = review.changes.map((change) => ({
    ...change,
    resultHash:
      change.operation === "delete" || change.proposalContent === null
        ? null
        : sha256(change.proposalContent),
  }));
  const decision: {
    kind: "approved";
    at: string;
    actor?: string;
    forced?: boolean;
  } = { kind: "approved", at: now };
  if (options.actor !== undefined) decision.actor = options.actor;
  if (options.force === true) decision.forced = true;
  const { conflict: _conflict, partialFailure: _partial, ...rest } = review;
  return {
    ...rest,
    status: "approved",
    revision: review.revision + 1,
    updatedAt: now,
    changes,
    decision,
  };
}

async function persistAuthoritativeConflict(
  store: ReviewStore,
  review: Review,
  conflicts: readonly {
    readonly changeId: string;
    readonly reason: ReviewConflict["reason"];
  }[],
): Promise<Review> {
  assertTransition(review.status, "conflicted");
  const next: Review = {
    ...review,
    status: "conflicted",
    revision: review.revision + 1,
    updatedAt: new Date().toISOString(),
    conflict: {
      detectedAt: new Date().toISOString(),
      changeIds: conflicts.map((item) => item.changeId),
      reason: conflicts[0]?.reason ?? "base-changed",
      advisory: false,
    },
  };
  await store.save(next);
  return next;
}

export async function rollbackEntries(
  entries: readonly TransactionEntry[],
): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const entry of entries) {
    try {
      await rollbackEntry(entry);
    } catch (error) {
      errors.push(`${entry.changeId}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

async function rollbackEntry(entry: TransactionEntry): Promise<void> {
  switch (entry.operation) {
    case "create":
    case "modify": {
      const backupExists = await exists(entry.backupPath);
      const stageExists = entry.stagePath !== null && (await exists(entry.stagePath));
      if (backupExists) {
        await rm(entry.targetPath, { recursive: false, force: true });
        await mkdir(path.dirname(entry.targetPath), { recursive: true });
        await rename(entry.backupPath, entry.targetPath);
      } else if (!entry.originalTargetExisted && !stageExists) {
        await rm(entry.targetPath, { recursive: false, force: true });
      }
      return;
    }
    case "delete": {
      if (entry.trashPath !== undefined && (await exists(entry.trashPath))) {
        await mkdir(path.dirname(entry.targetPath), { recursive: true });
        await rm(entry.targetPath, { force: true });
        await rename(entry.trashPath, entry.targetPath);
      }
      return;
    }
    case "rename": {
      if (entry.newTargetPath !== undefined) {
        const stageExists = entry.stagePath !== null && (await exists(entry.stagePath));
        if (!stageExists && (await exists(entry.newTargetPath))) {
          await rm(entry.newTargetPath, { force: true });
        }
      }
      if (await exists(entry.backupPath)) {
        await mkdir(path.dirname(entry.targetPath), { recursive: true });
        await rm(entry.targetPath, { force: true });
        await rename(entry.backupPath, entry.targetPath);
      }
      if (
        entry.newTargetPath !== undefined &&
        entry.newTargetBackupPath !== undefined &&
        (await exists(entry.newTargetBackupPath))
      ) {
        await mkdir(path.dirname(entry.newTargetPath), { recursive: true });
        await rename(entry.newTargetBackupPath, entry.newTargetPath);
      }
      return;
    }
  }
}

export async function preserveTransactionBackups(
  vaultRoot: string,
  reviewId: string,
  entries: readonly TransactionEntry[],
): Promise<void> {
  for (const entry of entries) {
    const backupCandidates = [
      { source: entry.backupPath, name: "target" },
      ...(entry.newTargetBackupPath === undefined
        ? []
        : [{ source: entry.newTargetBackupPath, name: "new-target" }]),
    ];
    for (const candidate of backupCandidates) {
      if (!(await exists(candidate.source))) continue;
      const destination = path.join(
        path.dirname(trashTargetPath(vaultRoot, reviewId, entry.target)),
        ".backups",
        entry.changeId,
        candidate.name,
      );
      await mkdir(path.dirname(destination), { recursive: true });
      if (await exists(destination)) await rm(destination, { force: true });
      await rename(candidate.source, destination);
      await fsyncDirectory(path.dirname(destination));
    }
  }
}

export async function writeJournal(
  transactionDirectoryPath: string,
  journal: TransactionJournal,
): Promise<void> {
  await atomicWriteFile(
    path.join(transactionDirectoryPath, "journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
}

export async function readJournal(
  transactionDirectoryPath: string,
  vaultRoot: string,
): Promise<TransactionJournal> {
  const parsed: unknown = JSON.parse(
    await readFile(path.join(transactionDirectoryPath, "journal.json"), "utf8"),
  );
  if (!isTransactionJournal(parsed)) {
    throw new ReviewError(
      "IO_ERROR",
      `Invalid transaction journal: ${transactionDirectoryPath}`,
    );
  }
  for (const entry of parsed.entries) {
    for (const candidate of [
      entry.targetPath,
      entry.stagePath,
      entry.backupPath,
      entry.newTargetPath,
      entry.newTargetBackupPath,
      entry.trashPath,
    ]) {
      if (candidate !== undefined && candidate !== null && !isPathInside(vaultRoot, candidate)) {
        throw new ReviewError(
          "INVALID_TARGET_PATH",
          "Transaction journal contains a path outside the vault.",
          { transactionDirectoryPath, candidate },
        );
      }
    }
  }
  return parsed;
}

function isTransactionJournal(value: unknown): value is TransactionJournal {
  if (!isRecord(value)) return false;
  return (
    value["schemaVersion"] === 1 &&
    typeof value["transactionId"] === "string" &&
    typeof value["reviewId"] === "string" &&
    typeof value["createdAt"] === "string" &&
    (value["phase"] === "prepared" ||
      value["phase"] === "applying" ||
      value["phase"] === "committed" ||
      value["phase"] === "rolled-back") &&
    Array.isArray(value["committedChangeIds"]) &&
    value["committedChangeIds"].every((item) => typeof item === "string") &&
    Array.isArray(value["entries"]) &&
    value["entries"].every(isTransactionEntry)
  );
}

function isTransactionEntry(value: unknown): value is TransactionEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value["changeId"] === "string" &&
    (value["operation"] === "create" ||
      value["operation"] === "modify" ||
      value["operation"] === "delete" ||
      value["operation"] === "rename") &&
    typeof value["target"] === "string" &&
    typeof value["targetPath"] === "string" &&
    typeof value["originalTargetExisted"] === "boolean" &&
    (value["stagePath"] === null || typeof value["stagePath"] === "string") &&
    typeof value["backupPath"] === "string" &&
    (value["newTarget"] === undefined || typeof value["newTarget"] === "string") &&
    (value["newTargetPath"] === undefined || typeof value["newTargetPath"] === "string") &&
    (value["originalNewTargetExisted"] === undefined ||
      typeof value["originalNewTargetExisted"] === "boolean") &&
    (value["newTargetBackupPath"] === undefined ||
      typeof value["newTargetBackupPath"] === "string") &&
    (value["trashPath"] === undefined || typeof value["trashPath"] === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
