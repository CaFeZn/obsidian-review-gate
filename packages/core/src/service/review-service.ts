import { readFile } from "../storage/file-system";
import path from "node:path";
import type {
  HunkDecisionKind,
  Review,
  ReviewChange,
  ReviewOperation,
  ReviewSource,
  ReviewAppend,
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
import {
  rebaseChange,
  reconcileReviewWithCurrentPriority,
} from "../conflict/rebase";
import { resolveSafeTarget, resolveVaultRoot } from "../path/safe-path";
import { ReviewStore, type ListReviewsOptions } from "../storage/review-store";
import { lockDirectory, reviewLayout } from "../storage/layout";
import { withDirectoryLock } from "../storage/lock";
import { recoverTransactions, type RecoveryItem } from "../storage/recovery";
import { approveReview, type ApproveOptions, type ApplyResult } from "../patch/apply";
import { materializeSemanticAppend } from "../patch/semantic-append";

export type SubmitOperation = ReviewOperation | "auto";

export interface SubmitChangeInput {
  readonly operation?: SubmitOperation;
  readonly target: string;
  readonly newTarget?: string;
  readonly anchor?: string;
  readonly appendAction?: "append" | "remove";
  readonly expectedBaseHash?: string | null;
  readonly proposalContent?: string;
}

export interface SubmitReviewInput {
  readonly id?: string;
  readonly source?: ReviewSource;
  readonly batchId?: string;
  readonly parentReviewId?: string;
  readonly revertsReviewId?: string;
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

export interface RevertReviewInput {
  readonly source?: ReviewSource;
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
    const submissionLock = path.join(
      reviewLayout(this.store.storageBase).locks,
      "submit-targets.lock",
    );
    return withDirectoryLock(submissionLock, () => this.submitLocked(input));
  }

  private async submitLocked(input: SubmitReviewInput): Promise<Review> {
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
      const baseHash = baseContent === null ? null : sha256(baseContent);
      if (
        candidate.expectedBaseHash !== undefined &&
        candidate.expectedBaseHash !== baseHash
      ) {
        throw new ReviewError(
          "REBASE_CONFLICT",
          `Target changed while preparing the review: ${target.target}`,
          {
            target: target.target,
            expectedHash: candidate.expectedBaseHash,
            currentHash: baseHash,
          },
        );
      }
      let proposalContent: string | null;
      let append: ReviewAppend | undefined;
      if (operation === "delete") {
        proposalContent = null;
      } else if (operation === "append") {
        if (candidate.anchor === undefined || candidate.anchor.length === 0) {
          throw new ReviewError(
            "INVALID_ARGUMENTS",
            `Append change requires an anchor: ${target.target}`,
            { target: target.target, operation },
          );
        }
        if (candidate.proposalContent === undefined || baseContent === null) {
          throw new ReviewError(
            "INVALID_ARGUMENTS",
            `Append change requires fragment content: ${target.target}`,
            { target: target.target, operation },
          );
        }
        append = {
          anchor: candidate.anchor,
          content: candidate.proposalContent,
          ...(candidate.appendAction === undefined ? {} : { action: candidate.appendAction }),
        };
        const applied = materializeSemanticAppend(baseContent, append);
        if (!applied.ok) {
          throw new ReviewError(
            "INVALID_ARGUMENTS",
            `Semantic append cannot be prepared for ${target.target}: ${applied.reason}.`,
            { target: target.target, anchor: append.anchor, reason: applied.reason },
          );
        }
        proposalContent = applied.content;
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
        baseHash,
        baseContent,
        proposalContent,
        proposalHash: proposalContent === null ? null : sha256(proposalContent),
        hunkDecisions: {},
      };
      if (append !== undefined) {
        (change as Mutable<ReviewChange>).append = append;
      }
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

    await this.assertTargetsAvailable(changes);

    const now = new Date().toISOString();
    const id = input.id ?? createReviewId();
    const review: Review = {
      schemaVersion: 1,
      id,
      status: "pending",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      changes,
    };
    if (input.source !== undefined && Object.keys(input.source).length > 0) {
      (review as Mutable<Review>).source = input.source;
    }
    (review as Mutable<Review>).batchId = input.batchId ?? id;
    if (input.parentReviewId !== undefined) {
      (review as Mutable<Review>).parentReviewId = input.parentReviewId;
    }
    if (input.revertsReviewId !== undefined) {
      (review as Mutable<Review>).revertsReviewId = input.revertsReviewId;
    }
    await this.store.create(review);
    return review;
  }

  public async append(input: SubmitReviewInput): Promise<Review> {
    if (input.changes.length !== 1) {
      throw new ReviewError(
        "INVALID_ARGUMENTS",
        "Append requires exactly one target change.",
      );
    }
    const candidate = input.changes[0];
    if (candidate === undefined || candidate.proposalContent === undefined) {
      throw new ReviewError(
        "INVALID_ARGUMENTS",
        "Append requires proposalContent.",
      );
    }
    const proposalContent = candidate.proposalContent;
    if (
      candidate.operation !== undefined &&
      candidate.operation !== "auto" &&
      candidate.operation !== "modify"
    ) {
      throw new ReviewError(
        "INVALID_ARGUMENTS",
        "Append supports only existing-file modifications.",
        { operation: candidate.operation },
      );
    }

    const target = await resolveSafeTarget(this.vaultRoot, candidate.target);
    if (!target.exists) {
      throw new ReviewError(
        "INVALID_ARGUMENTS",
        `Append target does not exist: ${target.target}`,
        { target: target.target },
      );
    }
    const targetLock = path.join(
      reviewLayout(this.store.storageBase).locks,
      `target-${sha256(target.target)}.lock`,
    );
    return withDirectoryLock(targetLock, async () => {
      const mutable = await this.list({
        locations: ["pending"],
        statuses: ["pending", "conflicted"],
      });
      const matches = mutable.filter((review) =>
        review.changes.some((change) => sameTarget(change.target, target.target)),
      );
      if (matches.length > 1) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `Append target belongs to multiple mutable reviews: ${target.target}`,
          { target: target.target, reviewIds: matches.map((review) => review.id) },
        );
      }
      const existing = matches[0];
      if (existing === undefined) {
        return this.submit({
          ...(input.source === undefined ? {} : { source: input.source }),
          ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
          ...(input.parentReviewId === undefined ? {} : { parentReviewId: input.parentReviewId }),
          ...(input.revertsReviewId === undefined ? {} : { revertsReviewId: input.revertsReviewId }),
          changes: [{ target: target.target, proposalContent }],
        });
      }
      return this.mergeProposalIntoReview(
        existing.id,
        target.target,
        proposalContent,
      );
    });
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
        await this.assertConflictFree(review);
        const change = review.changes.find((candidate) => candidate.id === input.changeId);
        if (change === undefined) {
          throw new ReviewError("CHANGE_NOT_FOUND", `Change not found: ${input.changeId}`, {
          reviewId,
          changeId: input.changeId,
        });
      }
      if (change.operation === "delete" || change.operation === "append") {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `${change.operation} changes do not have editable proposal content.`,
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
        await this.assertConflictFree(review);
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

  public async revert(
    reviewId: string,
    input: RevertReviewInput = {},
  ): Promise<Review> {
    const original = await this.get(reviewId);
    if (original.status !== "approved") {
      throw new ReviewError(
        "INVALID_STATE_TRANSITION",
        `Only an approved review can be reverted: ${reviewId}.`,
        { reviewId, status: original.status },
      );
    }
    const changes: SubmitChangeInput[] = [];
    for (const change of original.changes) {
      changes.push(await buildRevertChange(this.vaultRoot, original, change));
    }
    return this.submit({
      ...(input.source === undefined ? {} : { source: input.source }),
      batchId: original.batchId ?? original.id,
      parentReviewId: original.id,
      revertsReviewId: original.id,
      changes,
    });
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
      // Human edits win: adopt the current document as the new baseline and merge
      // the disjoint agent edits back on top instead of parking the review on an
      // advisory conflict.
      const reconciled = reconcileReviewWithCurrentPriority(review, inspection);
      await this.store.save(reconciled);
      return reconciled;
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
        if (change.operation === "append") {
          if (
            snapshot?.currentContent === null ||
            snapshot === undefined ||
            change.append === undefined
          ) {
            failed.push(change.id);
            changes.push(change);
          } else {
            const applied = materializeSemanticAppend(snapshot.currentContent, change.append);
            if (!applied.ok) {
              failed.push(change.id);
              changes.push(change);
            } else {
              changes.push({
                ...change,
                baseContent: snapshot.currentContent,
                baseHash: sha256(snapshot.currentContent),
                proposalContent: applied.content,
                proposalHash: sha256(applied.content),
                hunkDecisions: {},
              });
            }
          }
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

  private async assertTargetsAvailable(changes: readonly ReviewChange[]): Promise<void> {
    const incomingPaths = new Set<string>();
    for (const change of changes) {
      incomingPaths.add(change.target);
      if (change.newTarget !== undefined) incomingPaths.add(change.newTarget);
    }
    const mutable = await this.list({
      locations: ["pending"],
      statuses: ["pending", "conflicted"],
    });
    const collisions = mutable.filter((review) =>
      review.changes.some((existing) =>
        changes.some((incoming) => changesCompeteForTarget(incoming, existing)),
      ),
    );
    if (collisions.length === 0) return;
    throw new ReviewError(
      "REVIEW_CONFLICT",
      "One or more targets already belong to a mutable review. Use append to merge into the existing review.",
      {
        targets: [...incomingPaths].sort(),
        reviewIds: collisions.map((review) => review.id),
        command: "append",
      },
    );
  }

  private async assertConflictFree(review: Review): Promise<void> {
    const inspection = await inspectReviewConflicts(this.vaultRoot, review);
    if (inspection.conflicts.length === 0) return;
    throw new ReviewError(
      "REVIEW_CONFLICT",
      "Review targets changed after submission. Run rebase before writing the proposal.",
      {
        reviewId: review.id,
        changeIds: inspection.conflicts.map((conflict) => conflict.changeId),
        command: "rebase",
      },
    );
  }

  private async mergeProposalIntoReview(
    reviewId: string,
    target: string,
    proposalContent: string,
  ): Promise<Review> {
    return withDirectoryLock(lockDirectory(this.store.storageBase, reviewId), async () => {
      const review = await this.loadAndReconcile(reviewId);
      assertMutable(review);
      const matches = review.changes.filter((change) => sameTarget(change.target, target));
      if (matches.length !== 1) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `Append target is not unique in review ${reviewId}: ${target}`,
          { reviewId, target },
        );
      }
      const existing = matches[0];
      if (
        existing === undefined ||
        existing.operation !== "modify" ||
        existing.baseContent === null ||
        existing.proposalContent === null
      ) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          "Append can merge only into an existing modify change.",
          { reviewId, target, operation: existing?.operation },
        );
      }

      const resolved = await resolveSafeTarget(this.vaultRoot, target);
      if (!resolved.exists) {
        throw new ReviewError(
          "REBASE_CONFLICT",
          `Append target disappeared: ${target}`,
          { reviewId, target },
        );
      }
      const currentContent = await readFile(resolved.absolutePath, "utf8");
      let latestChange = existing;
      if (sha256(currentContent) !== existing.baseHash) {
        const rebased = rebaseChange(existing, currentContent);
        if (!rebased.clean || rebased.change === undefined) {
          throw appendConflict(reviewId, target, rebased.overlappingRanges);
        }
        latestChange = rebased.change;
      }

      const incoming: ReviewChange = {
        ...latestChange,
        proposalContent,
        proposalHash: sha256(proposalContent),
        hunkDecisions: {},
      };
      const merged = rebaseChange(incoming, latestChange.proposalContent ?? currentContent);
      if (!merged.clean || merged.change === undefined) {
        throw appendConflict(reviewId, target, merged.overlappingRanges);
      }
      const mergedChange: ReviewChange = {
        ...merged.change,
        baseHash: latestChange.baseHash,
        baseContent: latestChange.baseContent,
      };

      const provisional = mutateReview(
        review,
        replaceChange(review.changes, mergedChange),
      );
      const inspection = await inspectReviewConflicts(this.vaultRoot, provisional);
      if (inspection.conflicts.length > 0) {
        throw new ReviewError(
          "REVIEW_CONFLICT",
          "Review contains unresolved target changes. Run rebase before appending.",
          {
            reviewId,
            changeIds: inspection.conflicts.map((conflict) => conflict.changeId),
            command: "rebase",
          },
        );
      }
      const { conflict: _conflict, ...rest } = provisional;
      const next: Review = { ...rest, status: "pending" };
      await this.store.save(next);
      return next;
    });
  }
}

async function buildRevertChange(
  vaultRoot: string,
  review: Review,
  change: ReviewChange,
): Promise<SubmitChangeInput> {
  if (change.operation === "create") {
    const target = await resolveSafeTarget(vaultRoot, change.target);
    const current = target.exists ? await readFile(target.absolutePath, "utf8") : null;
    const expected = change.resultHash ?? change.proposalHash;
    if (current === null || expected === null || sha256(current) !== expected) {
      throw revertConflict(review, change, "created target changed or disappeared");
    }
    return {
      operation: "delete",
      target: change.target,
      expectedBaseHash: expected,
    };
  }

  if (change.operation === "delete") {
    const target = await resolveSafeTarget(vaultRoot, change.target);
    if (target.exists || change.baseContent === null) {
      throw revertConflict(review, change, "deleted target was recreated or has no backup");
    }
    return {
      operation: "create",
      target: change.target,
      expectedBaseHash: null,
      proposalContent: change.baseContent,
    };
  }

  if (change.operation === "append") {
    if (change.append === undefined) {
      throw revertConflict(review, change, "append metadata is missing");
    }
    const target = await resolveSafeTarget(vaultRoot, change.target);
    if (!target.exists) throw revertConflict(review, change, "append target disappeared");
    const current = await readFile(target.absolutePath, "utf8");
    const inverseAction = change.append.action === "remove" ? "append" : "remove";
    const inverse = { ...change.append, action: inverseAction } as const;
    const materialized = materializeSemanticAppend(current, inverse);
    if (!materialized.ok) {
      throw revertConflict(
        review,
        change,
        `semantic fragment cannot be reverted: ${materialized.reason}`,
      );
    }
    return {
      operation: "append",
      target: change.target,
      anchor: change.append.anchor,
      appendAction: inverseAction,
      expectedBaseHash: sha256(current),
      proposalContent: change.append.content,
    };
  }

  const sourceTarget = change.operation === "rename" ? change.newTarget : change.target;
  if (sourceTarget === undefined || change.baseContent === null || change.proposalContent === null) {
    throw revertConflict(review, change, "approved change has incomplete content metadata");
  }
  const target = await resolveSafeTarget(vaultRoot, sourceTarget);
  if (!target.exists) throw revertConflict(review, change, "current result target disappeared");
  if (change.operation === "rename") {
    const destination = await resolveSafeTarget(vaultRoot, change.target);
    if (destination.exists) {
      throw revertConflict(review, change, "original rename source path is occupied");
    }
  }
  const current = await readFile(target.absolutePath, "utf8");
  const inverse: ReviewChange = {
    ...change,
    operation: "modify",
    target: sourceTarget,
    baseContent: change.proposalContent,
    baseHash: change.resultHash ?? sha256(change.proposalContent),
    proposalContent: change.baseContent,
    proposalHash: sha256(change.baseContent),
    hunkDecisions: {},
  };
  const rebased = rebaseChange(inverse, current);
  if (!rebased.clean || rebased.change?.proposalContent === null || rebased.change === undefined) {
    throw revertConflict(review, change, "inverse patch overlaps later edits");
  }
  if (change.operation === "rename") {
    return {
      operation: "rename",
      target: sourceTarget,
      newTarget: change.target,
      expectedBaseHash: sha256(current),
      proposalContent: rebased.change.proposalContent,
    };
  }
  return {
    operation: "modify",
    target: change.target,
    expectedBaseHash: sha256(current),
    proposalContent: rebased.change.proposalContent,
  };
}

function revertConflict(review: Review, change: ReviewChange, reason: string): ReviewError {
  return new ReviewError(
    "REBASE_CONFLICT",
    `Review ${review.id} cannot be reverted safely for ${change.target}: ${reason}.`,
    { reviewId: review.id, changeId: change.id, target: change.target, reason },
  );
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

function sameTarget(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function changesCompeteForTarget(incoming: ReviewChange, existing: ReviewChange): boolean {
  const incomingPaths = [incoming.target, ...(incoming.newTarget === undefined ? [] : [incoming.newTarget])];
  const existingPaths = [existing.target, ...(existing.newTarget === undefined ? [] : [existing.newTarget])];
  const overlaps = incomingPaths.some((incomingPath) =>
    existingPaths.some((existingPath) => sameTarget(incomingPath, existingPath)),
  );
  if (!overlaps) return false;
  return incoming.operation !== "append" || existing.operation !== "append";
}

function appendConflict(
  reviewId: string,
  target: string,
  overlappingRanges:
    | readonly {
        readonly current: { readonly start: number; readonly end: number };
        readonly proposal: { readonly start: number; readonly end: number };
      }[]
    | undefined,
): ReviewError {
  return new ReviewError(
    "REBASE_CONFLICT",
    "Append could not merge overlapping edits into the existing review.",
    { reviewId, target, overlappingRanges: overlappingRanges ?? [] },
  );
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
