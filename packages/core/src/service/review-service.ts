import { readFile } from "../storage/file-system";
import type {
  HunkDecisionKind,
  Review,
  ReviewChange,
  ReviewConflict,
  ReviewOperation,
  ReviewSource,
} from "../model/review";
import { createChangeId, createReviewId } from "../model/id";
import { sha256 } from "../model/hash";
import { ReviewError } from "../model/errors";
import { assertTransition } from "../model/state-machine";
import { JsDiffEngine } from "../diff/jsdiff-engine";
import type { DiffEngine } from "../diff/types";
import { applyHunkDecision } from "../patch/hunk-operations";
import {
  buildConflictContext,
  inspectReviewConflicts,
  type ConflictContext,
} from "../conflict/check";
import { rebaseChange } from "../conflict/rebase";
import { resolveSafeTarget, resolveVaultRoot } from "../path/safe-path";
import { ReviewStore, type ListReviewsOptions } from "../storage/review-store";
import { lockDirectory } from "../storage/layout";
import { withDirectoryLock } from "../storage/lock";
import { recoverTransactions, type RecoveryItem } from "../storage/recovery";
import { approveReview, type ApproveOptions, type ApplyResult } from "../patch/apply";

export type SubmitOperation = ReviewOperation | "auto";

export interface SubmitChangeInput {
  readonly operation?: SubmitOperation;
  readonly target: string;
  readonly newTarget?: string;
  readonly proposalContent?: string;
}

export interface SubmitReviewInput {
  readonly id?: string;
  readonly source?: ReviewSource;
  readonly changes: readonly SubmitChangeInput[];
}

export interface RevisionOptions {
  readonly expectedRevision?: number;
  readonly actor?: string;
}

export interface UpdateProposalInput extends RevisionOptions {
  readonly changeId: string;
  readonly proposalContent: string;
}

export interface HunkDecisionInput extends RevisionOptions {
  readonly changeId: string;
  readonly hunkId: string;
  readonly decision: HunkDecisionKind;
}

export interface ReviewServiceOpenOptions {
  readonly diffEngine?: DiffEngine;
  readonly storageBase?: string;
}

export class ReviewService {
  public readonly vaultRoot: string;
  public readonly store: ReviewStore;
  public readonly diffEngine: DiffEngine;

  private constructor(vaultRoot: string, storageBase: string, diffEngine: DiffEngine) {
    this.vaultRoot = vaultRoot;
    this.store = new ReviewStore(vaultRoot, storageBase);
    this.diffEngine = diffEngine;
  }

  public static async open(
    vault: string,
    options: ReviewServiceOpenOptions = {},
  ): Promise<{ readonly service: ReviewService; readonly recovery: readonly RecoveryItem[] }> {
    const vaultRoot = await resolveVaultRoot(vault);
    const service = new ReviewService(
      vaultRoot,
      options.storageBase ?? vaultRoot,
      options.diffEngine ?? new JsDiffEngine(),
    );
    await service.store.initialize();
    const recovery = await recoverTransactions(service.store);
    return { service, recovery };
  }

  public async submit(input: SubmitReviewInput): Promise<Review> {
    if (input.changes.length === 0) {
      throw new ReviewError("INVALID_ARGUMENTS", "A review must contain at least one change.");
    }
    const seen = new Set<string>();
    const changes: ReviewChange[] = [];
    for (let index = 0; index < input.changes.length; index += 1) {
      const candidate = input.changes[index];
      if (candidate === undefined) continue;
      const target = await resolveSafeTarget(this.vaultRoot, candidate.target);
      assertUniquePath(seen, target.target);
      const requested = candidate.operation ?? "auto";
      const operation: ReviewOperation =
        requested === "auto" ? (target.exists ? "modify" : "create") : requested;

      if (operation === "create" && target.exists) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `Create target already exists: ${target.target}`,
          { target: target.target },
        );
      }
      if (operation !== "create" && !target.exists) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `${operation} target does not exist: ${target.target}`,
          { target: target.target, operation },
        );
      }

      const baseContent = target.exists
        ? await readFile(target.absolutePath, "utf8")
        : null;
      let proposalContent: string | null;
      if (operation === "delete") {
        proposalContent = null;
      } else if (candidate.proposalContent !== undefined) {
        proposalContent = candidate.proposalContent;
      } else if (operation === "rename") {
        proposalContent = baseContent;
      } else {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `${operation} change requires proposalContent: ${target.target}`,
          { target: target.target, operation },
        );
      }

      const change: ReviewChange = {
        id: createChangeId(index + 1),
        operation,
        target: target.target,
        baseHash: baseContent === null ? null : sha256(baseContent),
        baseContent,
        proposalContent,
        proposalHash: proposalContent === null ? null : sha256(proposalContent),
        hunkDecisions: {},
      };
      if (operation === "rename") {
        if (candidate.newTarget === undefined) {
          throw new ReviewError(
            "INVALID_ARGUMENTS",
            `Rename change requires newTarget: ${target.target}`,
            { target: target.target },
          );
        }
        const destination = await resolveSafeTarget(this.vaultRoot, candidate.newTarget);
        if (destination.exists) {
          throw new ReviewError(
            "INVALID_ARGUMENTS",
            `Rename destination already exists: ${destination.target}`,
            { newTarget: destination.target },
          );
        }
        assertUniquePath(seen, destination.target);
        (change as Mutable<ReviewChange>).newTarget = destination.target;
      }
      changes.push(change);
    }

    const now = new Date().toISOString();
    const review: Review = {
      schemaVersion: 1,
      id: input.id ?? createReviewId(),
      status: "pending",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      changes,
    };
    if (input.source !== undefined && Object.keys(input.source).length > 0) {
      (review as Mutable<Review>).source = input.source;
    }
    await this.store.create(review);
    return review;
  }

  public async get(reviewId: string): Promise<Review> {
    return withDirectoryLock(lockDirectory(this.store.storageBase, reviewId), async () => {
      return this.loadAndReconcile(reviewId);
    });
  }

  public async list(options?: ListReviewsOptions): Promise<readonly Review[]> {
    const reviews = await this.store.list(options);
    const result: Review[] = [];
    for (const review of reviews) {
      if (review.status === "pending" || review.status === "conflicted") {
        result.push(await this.get(review.id));
      } else {
        result.push(review);
      }
    }
    return result;
  }

  public async updateProposal(
    reviewId: string,
    input: UpdateProposalInput,
  ): Promise<Review> {
    return withDirectoryLock(lockDirectory(this.store.storageBase, reviewId), async () => {
      const review = await this.loadAndReconcile(reviewId);
      assertMutable(review);
      assertExpectedRevision(review, input.expectedRevision);
      const change = review.changes.find((candidate) => candidate.id === input.changeId);
      if (change === undefined) {
        throw new ReviewError("CHANGE_NOT_FOUND", `Change not found: ${input.changeId}`, {
          reviewId,
          changeId: input.changeId,
        });
      }
      if (change.operation === "delete") {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          "Delete changes do not have editable proposal content.",
          { reviewId, changeId: change.id },
        );
      }
      const nextChange: ReviewChange = {
        ...change,
        proposalContent: input.proposalContent,
        proposalHash: sha256(input.proposalContent),
        hunkDecisions: {},
      };
      const next = mutateReview(review, replaceChange(review.changes, nextChange));
      await this.store.save(next);
      return next;
    });
  }

  public async decideHunk(
    reviewId: string,
    input: HunkDecisionInput,
  ): Promise<Review> {
    return withDirectoryLock(lockDirectory(this.store.storageBase, reviewId), async () => {
      const review = await this.loadAndReconcile(reviewId);
      assertMutable(review);
      assertExpectedRevision(review, input.expectedRevision);
      const change = review.changes.find((candidate) => candidate.id === input.changeId);
      if (change === undefined) {
        throw new ReviewError("CHANGE_NOT_FOUND", `Change not found: ${input.changeId}`, {
          reviewId,
          changeId: input.changeId,
        });
      }
      const nextChange = applyHunkDecision(
        change,
        input.hunkId,
        input.decision,
        this.diffEngine,
      );
      const next = mutateReview(review, replaceChange(review.changes, nextChange));
      await this.store.save(next);
      return next;
    });
  }

  public async approve(reviewId: string, options?: ApproveOptions): Promise<ApplyResult> {
    return approveReview(this.store, reviewId, options);
  }

  public async reject(reviewId: string, options: RevisionOptions = {}): Promise<Review> {
    return this.finalizeWithoutApply(reviewId, "rejected", options);
  }

  public async cancel(reviewId: string, options: RevisionOptions = {}): Promise<Review> {
    return this.finalizeWithoutApply(reviewId, "cancelled", options);
  }

  public async markPotentialConflict(reviewId: string): Promise<Review> {
    return withDirectoryLock(lockDirectory(this.store.storageBase, reviewId), async () => {
      const review = await this.loadAndReconcile(reviewId);
      if (review.status !== "pending" && review.status !== "conflicted") return review;
      const inspection = await inspectReviewConflicts(this.vaultRoot, review);
      if (inspection.conflicts.length === 0) {
        if (review.conflict?.advisory !== true) return review;
        const { conflict: _conflict, ...rest } = review;
        const next: Review = {
          ...rest,
          revision: review.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        await this.store.save(next);
        return next;
      }
      const first = inspection.conflicts[0];
      if (first === undefined) return review;
      const conflict: ReviewConflict = {
        detectedAt: new Date().toISOString(),
        changeIds: inspection.conflicts.map((item) => item.changeId),
        reason: first.reason,
        advisory: true,
      };
      if (
        review.conflict?.advisory === true &&
        review.conflict.reason === conflict.reason &&
        sameStrings(review.conflict.changeIds, conflict.changeIds)
      ) {
        return review;
      }
      const next: Review = {
        ...review,
        revision: review.revision + 1,
        updatedAt: new Date().toISOString(),
        conflict,
      };
      await this.store.save(next);
      return next;
    });
  }

  public async rebase(
    reviewId: string,
    options: RevisionOptions = {},
  ): Promise<Review> {
    return withDirectoryLock(lockDirectory(this.store.storageBase, reviewId), async () => {
      const review = await this.loadAndReconcile(reviewId);
      assertMutable(review);
      assertExpectedRevision(review, options.expectedRevision);
      const inspection = await inspectReviewConflicts(this.vaultRoot, review);
      const changes: ReviewChange[] = [];
      const failed: string[] = [];

      for (const change of review.changes) {
        const snapshot = inspection.snapshots.get(change.id);
        if (change.operation === "create") {
          if (snapshot?.exists === true) failed.push(change.id);
          changes.push(change);
          continue;
        }
        if (change.operation === "delete") {
          if (snapshot?.currentContent === null || snapshot === undefined) {
            failed.push(change.id);
            changes.push(change);
          } else {
            changes.push({
              ...change,
              baseContent: snapshot.currentContent,
              baseHash: sha256(snapshot.currentContent),
              hunkDecisions: {},
            });
          }
          continue;
        }
        if (snapshot?.currentContent === null || snapshot === undefined) {
          failed.push(change.id);
          changes.push(change);
          continue;
        }
        if (change.operation === "rename" && snapshot.newTargetExists === true) {
          failed.push(change.id);
          changes.push(change);
          continue;
        }
        const result = rebaseChange(change, snapshot.currentContent);
        if (!result.clean || result.change === undefined) {
          failed.push(change.id);
          changes.push(change);
        } else {
          changes.push(result.change);
        }
      }

      if (failed.length > 0) {
        const next: Review = {
          ...review,
          status: "conflicted",
          revision: review.revision + 1,
          updatedAt: new Date().toISOString(),
          conflict: {
            detectedAt: new Date().toISOString(),
            changeIds: failed,
            reason: "base-changed",
            advisory: false,
          },
        };
        await this.store.save(next);
        throw new ReviewError(
          "REBASE_CONFLICT",
          "Automatic rebase was refused because one or more changes overlap or cannot be represented safely.",
          { reviewId, changeIds: failed, revision: next.revision },
        );
      }

      const { conflict: _conflict, ...rest } = review;
      const next: Review = {
        ...rest,
        status: "pending",
        revision: review.revision + 1,
        updatedAt: new Date().toISOString(),
        changes,
      };
      await this.store.save(next);
      return next;
    });
  }

  public async conflictContext(reviewId: string): Promise<readonly ConflictContext[]> {
    const review = await this.get(reviewId);
    const inspection = await inspectReviewConflicts(this.vaultRoot, review);
    return buildConflictContext(review, inspection);
  }

  private async finalizeWithoutApply(
    reviewId: string,
    status: "rejected" | "cancelled",
    options: RevisionOptions,
  ): Promise<Review> {
    return withDirectoryLock(lockDirectory(this.store.storageBase, reviewId), async () => {
      const review = await this.loadAndReconcile(reviewId);
      assertMutable(review);
      assertExpectedRevision(review, options.expectedRevision);
      assertTransition(review.status, status);
      const now = new Date().toISOString();
      const decision: {
        kind: typeof status;
        at: string;
        actor?: string;
      } = { kind: status, at: now };
      if (options.actor !== undefined) decision.actor = options.actor;
      const next: Review = {
        ...review,
        status,
        revision: review.revision + 1,
        updatedAt: now,
        decision,
      };
      await this.store.archive(next);
      return next;
    });
  }

  private async loadAndReconcile(reviewId: string): Promise<Review> {
    const located = await this.store.loadLocated(reviewId);
    if (located.location !== "pending" || located.externalProposalChangeIds.length === 0) {
      return located.review;
    }
    const changed = new Set(located.externalProposalChangeIds);
    const changes = located.review.changes.map((change) =>
      changed.has(change.id) ? { ...change, hunkDecisions: {} } : change,
    );
    const next = mutateReview(located.review, changes);
    await this.store.save(next);
    return next;
  }
}

function mutateReview(review: Review, changes: readonly ReviewChange[]): Review {
  return {
    ...review,
    revision: review.revision + 1,
    updatedAt: new Date().toISOString(),
    changes,
  };
}

function replaceChange(
  changes: readonly ReviewChange[],
  replacement: ReviewChange,
): readonly ReviewChange[] {
  return changes.map((change) => (change.id === replacement.id ? replacement : change));
}

function assertMutable(review: Review): void {
  if (review.status !== "pending" && review.status !== "conflicted") {
    throw new ReviewError(
      "INVALID_STATE_TRANSITION",
      `Review with status ${review.status} is immutable.`,
      { reviewId: review.id, status: review.status },
    );
  }
}

function assertExpectedRevision(review: Review, expected: number | undefined): void {
  if (expected !== undefined && review.revision !== expected) {
    throw new ReviewError(
      "REVISION_CONFLICT",
      `Expected revision ${expected}, found ${review.revision}.`,
      {
        reviewId: review.id,
        expectedRevision: expected,
        actualRevision: review.revision,
      },
    );
  }
}

function assertUniquePath(seen: Set<string>, target: string): void {
  const key = process.platform === "win32" ? target.toLocaleLowerCase("en-US") : target;
  if (seen.has(key)) {
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      `A multi-file review cannot target the same path twice: ${target}`,
      { target },
    );
  }
  seen.add(key);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
