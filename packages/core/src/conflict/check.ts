import { readFile } from "node:fs/promises";
import type { Review, ReviewChange } from "../model/review";
import { sha256 } from "../model/hash";
import { resolveSafeTarget } from "../path/safe-path";

export interface ChangeSnapshot {
  readonly changeId: string;
  readonly target: string;
  readonly exists: boolean;
  readonly currentContent: string | null;
  readonly currentHash: string | null;
  readonly newTargetExists?: boolean;
}

export type ConflictReason =
  | "base-changed"
  | "create-target-exists"
  | "rename-target-exists";

export interface ConflictFinding {
  readonly changeId: string;
  readonly target: string;
  readonly reason: ConflictReason;
  readonly expectedHash: string | null;
  readonly currentHash: string | null;
}

export interface ConflictInspection {
  readonly snapshots: ReadonlyMap<string, ChangeSnapshot>;
  readonly conflicts: readonly ConflictFinding[];
}

export interface ConflictContext {
  readonly changeId: string;
  readonly operation: ReviewChange["operation"];
  readonly target: string;
  readonly newTarget?: string;
  readonly base: string | null;
  readonly current: string | null;
  readonly proposal: string | null;
  readonly baseHash: string | null;
  readonly currentHash: string | null;
  readonly proposalHash: string | null;
}

export async function inspectReviewConflicts(
  vaultRoot: string,
  review: Review,
): Promise<ConflictInspection> {
  const snapshots = new Map<string, ChangeSnapshot>();
  const conflicts: ConflictFinding[] = [];

  for (const change of review.changes) {
    const resolved = await resolveSafeTarget(vaultRoot, change.target);
    const currentContent = resolved.exists
      ? await readFile(resolved.absolutePath, "utf8")
      : null;
    const currentHash = currentContent === null ? null : sha256(currentContent);

    let newTargetExists: boolean | undefined;
    if (change.operation === "rename" && change.newTarget !== undefined) {
      newTargetExists = (await resolveSafeTarget(vaultRoot, change.newTarget)).exists;
    }
    const snapshot: ChangeSnapshot = {
      changeId: change.id,
      target: change.target,
      exists: resolved.exists,
      currentContent,
      currentHash,
    };
    if (newTargetExists !== undefined) {
      (snapshot as { newTargetExists?: boolean }).newTargetExists = newTargetExists;
    }
    snapshots.set(change.id, snapshot);

    if (change.operation === "create") {
      if (resolved.exists) {
        conflicts.push({
          changeId: change.id,
          target: change.target,
          reason: "create-target-exists",
          expectedHash: null,
          currentHash,
        });
      }
      continue;
    }

    if (currentHash !== change.baseHash) {
      conflicts.push({
        changeId: change.id,
        target: change.target,
        reason: "base-changed",
        expectedHash: change.baseHash,
        currentHash,
      });
    }
    if (change.operation === "rename" && newTargetExists === true) {
      conflicts.push({
        changeId: change.id,
        target: change.newTarget ?? change.target,
        reason: "rename-target-exists",
        expectedHash: null,
        currentHash: null,
      });
    }
  }
  return { snapshots, conflicts };
}

export function buildConflictContext(
  review: Review,
  inspection: ConflictInspection,
): readonly ConflictContext[] {
  return review.changes.map((change) => {
    const snapshot = inspection.snapshots.get(change.id);
    const context: ConflictContext = {
      changeId: change.id,
      operation: change.operation,
      target: change.target,
      base: change.baseContent,
      current: snapshot?.currentContent ?? null,
      proposal: change.proposalContent,
      baseHash: change.baseHash,
      currentHash: snapshot?.currentHash ?? null,
      proposalHash: change.proposalHash,
    };
    if (change.newTarget !== undefined) {
      (context as { newTarget?: string }).newTarget = change.newTarget;
    }
    return context;
  });
}
