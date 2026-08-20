import { mkdir, readFile, readdir, rename, rm } from "./file-system";
import path from "node:path";
import type {
  HunkDecision,
  PartialFailure,
  Review,
  ReviewChange,
  ReviewConflict,
  ReviewDecision,
  ReviewOperation,
  ReviewSource,
  ReviewStatus,
  StoredReview,
  StoredReviewChange,
} from "../model/review";
import { sha256 } from "../model/hash";
import { ReviewError } from "../model/errors";
import { atomicWriteFile, exists, fsyncDirectory } from "./atomic";
import {
  changeDirectory,
  eventPath,
  historyReviewDirectory,
  pendingReviewDirectory,
  reviewLayout,
  reviewMetaPath,
  safeReviewId,
} from "./layout";

export type ReviewLocation = "pending" | "history";

export interface LoadedReview {
  readonly review: Review;
  readonly location: ReviewLocation;
  readonly directory: string;
  /** Proposal files changed without a matching metadata revision update. */
  readonly externalProposalChangeIds: readonly string[];
}

export interface ListReviewsOptions {
  readonly locations?: readonly ReviewLocation[];
  readonly statuses?: readonly ReviewStatus[];
}

export class ReviewStore {
  public readonly vaultRoot: string;
  public readonly storageBase: string;

  public constructor(vaultRoot: string, storageBase: string = vaultRoot) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.storageBase = path.resolve(storageBase);
  }

  public async initialize(): Promise<void> {
    const layout = reviewLayout(this.storageBase);
    await Promise.all([
      mkdir(layout.pending, { recursive: true }),
      mkdir(layout.history, { recursive: true }),
      mkdir(layout.locks, { recursive: true }),
      mkdir(layout.transactions, { recursive: true }),
      mkdir(layout.events, { recursive: true }),
      mkdir(layout.trash, { recursive: true }),
    ]);
  }

  public async create(review: Review): Promise<void> {
    await this.initialize();
    const directory = pendingReviewDirectory(this.storageBase, review.id);
    try {
      await mkdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `Review already exists: ${review.id}`,
          { reviewId: review.id },
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await this.saveAt(review, directory);
      await this.writeEvent(review);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  public async load(reviewId: string): Promise<Review> {
    return (await this.loadLocated(reviewId)).review;
  }

  public async loadLocated(reviewId: string): Promise<LoadedReview> {
    safeReviewId(reviewId);
    const pending = pendingReviewDirectory(this.storageBase, reviewId);
    if (await exists(pending)) return this.loadFromDirectory(pending, "pending");
    const history = historyReviewDirectory(this.storageBase, reviewId);
    if (await exists(history)) return this.loadFromDirectory(history, "history");
    throw new ReviewError("REVIEW_NOT_FOUND", `Review not found: ${reviewId}`, {
      reviewId,
    });
  }

  public async save(review: Review): Promise<void> {
    const located = await this.loadLocated(review.id);
    await this.saveAt(review, located.directory);
    await this.writeEvent(review);
  }

  public async archive(review: Review): Promise<void> {
    const source = pendingReviewDirectory(this.storageBase, review.id);
    if (!(await exists(source))) {
      throw new ReviewError(
        "INVALID_STATE_TRANSITION",
        `Only a pending review directory can be archived: ${review.id}`,
        { reviewId: review.id },
      );
    }
    await this.saveAt(review, source);
    const destination = historyReviewDirectory(this.storageBase, review.id);
    if (await exists(destination)) {
      throw new ReviewError(
        "IO_ERROR",
        `History destination already exists for review ${review.id}.`,
        { reviewId: review.id },
      );
    }
    await rename(source, destination);
    await fsyncDirectory(path.dirname(source));
    await fsyncDirectory(path.dirname(destination));
    await this.writeEvent(review);
  }

  public async list(options: ListReviewsOptions = {}): Promise<readonly Review[]> {
    await this.initialize();
    const locations = options.locations ?? ["pending", "history"];
    const statuses = options.statuses === undefined ? null : new Set(options.statuses);
    const result: Review[] = [];
    for (const location of locations) {
      const root =
        location === "pending"
          ? reviewLayout(this.storageBase).pending
          : reviewLayout(this.storageBase).history;
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(entry.name)) {
          continue;
        }
        try {
          const loaded = await this.loadFromDirectory(
            path.join(root, entry.name),
            location,
          );
          if (statuses === null || statuses.has(loaded.review.status)) {
            result.push(loaded.review);
          }
        } catch (error) {
          if (error instanceof ReviewError && error.code === "CORRUPTED_REVIEW") {
            continue;
          }
          throw error;
        }
      }
    }
    result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return result;
  }

  public async readStored(reviewId: string): Promise<{
    readonly stored: StoredReview;
    readonly location: ReviewLocation;
    readonly directory: string;
  }> {
    const located = await this.locate(reviewId);
    const stored = await readStoredMeta(located.directory);
    return { stored, ...located };
  }

  private async locate(reviewId: string): Promise<{
    readonly location: ReviewLocation;
    readonly directory: string;
  }> {
    safeReviewId(reviewId);
    const pending = pendingReviewDirectory(this.storageBase, reviewId);
    if (await exists(pending)) return { location: "pending", directory: pending };
    const history = historyReviewDirectory(this.storageBase, reviewId);
    if (await exists(history)) return { location: "history", directory: history };
    throw new ReviewError("REVIEW_NOT_FOUND", `Review not found: ${reviewId}`, {
      reviewId,
    });
  }

  private async loadFromDirectory(
    directory: string,
    location: ReviewLocation,
  ): Promise<LoadedReview> {
    const stored = await readStoredMeta(directory);
    const changes: ReviewChange[] = [];
    const externalProposalChangeIds: string[] = [];

    for (const change of stored.changes) {
      const baseContent =
        change.baseFile === null
          ? null
          : await readReviewContent(directory, change.baseFile, stored.id);
      if (
        change.baseHash !== null &&
        (baseContent === null || sha256(baseContent) !== change.baseHash)
      ) {
        throw new ReviewError(
          "CORRUPTED_REVIEW",
          `Base content hash mismatch for ${stored.id}/${change.id}.`,
          { reviewId: stored.id, changeId: change.id },
        );
      }
      const proposalContent =
        change.proposalFile === null
          ? null
          : await readReviewContent(directory, change.proposalFile, stored.id);
      const actualProposalHash =
        proposalContent === null ? null : sha256(proposalContent);
      if (actualProposalHash !== change.proposalHash) {
        externalProposalChangeIds.push(change.id);
      }

      const hydrated: ReviewChange = {
        id: change.id,
        operation: change.operation,
        target: change.target,
        baseHash: change.baseHash,
        baseContent,
        proposalContent,
        proposalHash: actualProposalHash,
        hunkDecisions: change.hunkDecisions,
      };
      if (change.newTarget !== undefined) {
        (hydrated as Mutable<ReviewChange>).newTarget = change.newTarget;
      }
      if (change.resultHash !== undefined) {
        (hydrated as Mutable<ReviewChange>).resultHash = change.resultHash;
      }
      changes.push(hydrated);
    }

    const review = hydrateReview(stored, changes);
    return {
      review,
      location,
      directory,
      externalProposalChangeIds,
    };
  }

  private async saveAt(review: Review, directory: string): Promise<void> {
    await mkdir(path.join(directory, "changes"), { recursive: true });
    const storedChanges: StoredReviewChange[] = [];
    for (const change of review.changes) {
      const directoryForChange = changeDirectory(directory, change.id);
      await mkdir(directoryForChange, { recursive: true });
      const baseFile =
        change.baseContent === null ? null : `changes/${change.id}/base.rgdata`;
      const proposalFile =
        change.proposalContent === null ? null : `changes/${change.id}/proposal.rgdata`;
      const baseContent = change.baseContent;
      if (baseFile !== null && baseContent !== null) {
        await atomicWriteFile(path.join(directory, ...baseFile.split("/")), baseContent);
      }
      const proposalContent = change.proposalContent;
      if (proposalFile !== null && proposalContent !== null) {
        await atomicWriteFile(
          path.join(directory, ...proposalFile.split("/")),
          proposalContent,
        );
      }
      const storedChange: StoredReviewChange = {
        id: change.id,
        operation: change.operation,
        target: change.target,
        baseHash: change.baseHash,
        baseFile,
        proposalFile,
        proposalHash:
          change.proposalContent === null ? null : sha256(change.proposalContent),
        hunkDecisions: change.hunkDecisions,
      };
      if (change.newTarget !== undefined) {
        (storedChange as Mutable<StoredReviewChange>).newTarget = change.newTarget;
      }
      if (change.resultHash !== undefined) {
        (storedChange as Mutable<StoredReviewChange>).resultHash = change.resultHash;
      }
      storedChanges.push(storedChange);
    }

    const stored = dehydrateReview(review, storedChanges);
    await atomicWriteFile(
      reviewMetaPath(directory),
      `${JSON.stringify(stored, null, 2)}\n`,
    );
  }

  private async writeEvent(review: Review): Promise<void> {
    await atomicWriteFile(
      eventPath(this.storageBase, review.id),
      `${JSON.stringify({
        reviewId: review.id,
        status: review.status,
        revision: review.revision,
        updatedAt: review.updatedAt,
      })}\n`,
      { durable: false },
    );
  }
}

async function readStoredMeta(directory: string): Promise<StoredReview> {
  let raw: string;
  try {
    raw = await readFile(reviewMetaPath(directory), "utf8");
  } catch (error) {
    throw new ReviewError(
      "CORRUPTED_REVIEW",
      `Review metadata cannot be read: ${directory}`,
      { directory },
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReviewError(
      "CORRUPTED_REVIEW",
      `Review metadata is not valid JSON: ${directory}`,
      { directory },
      { cause: error },
    );
  }
  if (!isStoredReview(parsed)) {
    throw new ReviewError(
      "CORRUPTED_REVIEW",
      `Review metadata does not match schema version 1: ${directory}`,
      { directory },
    );
  }
  return parsed;
}

async function readReviewContent(
  directory: string,
  relative: string,
  reviewId: string,
): Promise<string> {
  if (!/^changes\/\d{4}\/(?:base|proposal)\.rgdata$/u.test(relative)) {
    throw new ReviewError(
      "CORRUPTED_REVIEW",
      `Unsafe content path in review ${reviewId}.`,
      { reviewId, path: relative },
    );
  }
  try {
    return await readFile(path.join(directory, ...relative.split("/")), "utf8");
  } catch (error) {
    throw new ReviewError(
      "CORRUPTED_REVIEW",
      `Review content file cannot be read: ${relative}`,
      { reviewId, path: relative },
      { cause: error },
    );
  }
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function hydrateReview(stored: StoredReview, changes: readonly ReviewChange[]): Review {
  const review: Review = {
    schemaVersion: 1,
    id: stored.id,
    status: stored.status,
    revision: stored.revision,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    changes,
  };
  const mutable = review as Mutable<Review>;
  if (stored.source !== undefined) mutable.source = stored.source;
  if (stored.conflict !== undefined) mutable.conflict = stored.conflict;
  if (stored.decision !== undefined) mutable.decision = stored.decision;
  if (stored.partialFailure !== undefined) mutable.partialFailure = stored.partialFailure;
  return review;
}

function dehydrateReview(
  review: Review,
  changes: readonly StoredReviewChange[],
): StoredReview {
  const stored: StoredReview = {
    schemaVersion: 1,
    id: review.id,
    status: review.status,
    revision: review.revision,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    changes,
  };
  const mutable = stored as Mutable<StoredReview>;
  if (review.source !== undefined) mutable.source = review.source;
  if (review.conflict !== undefined) mutable.conflict = review.conflict;
  if (review.decision !== undefined) mutable.decision = review.decision;
  if (review.partialFailure !== undefined) mutable.partialFailure = review.partialFailure;
  return stored;
}

const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "pending",
  "approved",
  "rejected",
  "conflicted",
  "cancelled",
];
const OPERATIONS: readonly ReviewOperation[] = ["create", "modify", "delete", "rename"];

function isStoredReview(value: unknown): value is StoredReview {
  if (!isRecord(value)) return false;
  if (
    value["schemaVersion"] !== 1 ||
    typeof value["id"] !== "string" ||
    !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value["id"]) ||
    !isReviewStatus(value["status"]) ||
    !Number.isSafeInteger(value["revision"]) ||
    (value["revision"] as number) < 1 ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    !Array.isArray(value["changes"]) ||
    !value["changes"].every(isStoredChange)
  ) {
    return false;
  }
  if (value["source"] !== undefined && !isSource(value["source"])) return false;
  if (value["conflict"] !== undefined && !isConflict(value["conflict"])) return false;
  if (value["decision"] !== undefined && !isDecision(value["decision"])) return false;
  if (value["partialFailure"] !== undefined && !isPartialFailure(value["partialFailure"])) {
    return false;
  }
  return true;
}

function isStoredChange(value: unknown): value is StoredReviewChange {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    /^\d{4}$/u.test(value["id"]) &&
    isOperation(value["operation"]) &&
    typeof value["target"] === "string" &&
    (value["newTarget"] === undefined || typeof value["newTarget"] === "string") &&
    (value["baseHash"] === null || typeof value["baseHash"] === "string") &&
    (value["baseFile"] === null || typeof value["baseFile"] === "string") &&
    (value["proposalFile"] === null || typeof value["proposalFile"] === "string") &&
    (value["proposalHash"] === null || typeof value["proposalHash"] === "string") &&
    (value["resultHash"] === undefined ||
      value["resultHash"] === null ||
      typeof value["resultHash"] === "string") &&
    isHunkDecisions(value["hunkDecisions"])
  );
}

function isHunkDecisions(value: unknown): value is Readonly<Record<string, HunkDecision>> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (decision) =>
      isRecord(decision) &&
      (decision["decision"] === "accepted" || decision["decision"] === "rejected") &&
      typeof decision["at"] === "string" &&
      typeof decision["baseHash"] === "string" &&
      typeof decision["proposalHash"] === "string",
  );
}

function isSource(value: unknown): value is ReviewSource {
  return (
    isRecord(value) &&
    (value["agent"] === undefined || typeof value["agent"] === "string") &&
    (value["session"] === undefined || typeof value["session"] === "string")
  );
}

function isConflict(value: unknown): value is ReviewConflict {
  return (
    isRecord(value) &&
    typeof value["detectedAt"] === "string" &&
    Array.isArray(value["changeIds"]) &&
    value["changeIds"].every((item) => typeof item === "string") &&
    (value["reason"] === "base-changed" ||
      value["reason"] === "create-target-exists" ||
      value["reason"] === "rename-target-exists") &&
    typeof value["advisory"] === "boolean"
  );
}

function isDecision(value: unknown): value is ReviewDecision {
  return (
    isRecord(value) &&
    (value["kind"] === "approved" ||
      value["kind"] === "rejected" ||
      value["kind"] === "cancelled") &&
    typeof value["at"] === "string" &&
    (value["actor"] === undefined || typeof value["actor"] === "string") &&
    (value["forced"] === undefined || typeof value["forced"] === "boolean")
  );
}

function isPartialFailure(value: unknown): value is PartialFailure {
  return (
    isRecord(value) &&
    typeof value["transactionId"] === "string" &&
    typeof value["failedAt"] === "string" &&
    typeof value["message"] === "string" &&
    Array.isArray(value["committedChangeIds"]) &&
    value["committedChangeIds"].every((item) => typeof item === "string") &&
    Array.isArray(value["rollbackErrors"]) &&
    value["rollbackErrors"].every((item) => typeof item === "string")
  );
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && REVIEW_STATUSES.includes(value as ReviewStatus);
}

function isOperation(value: unknown): value is ReviewOperation {
  return typeof value === "string" && OPERATIONS.includes(value as ReviewOperation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
