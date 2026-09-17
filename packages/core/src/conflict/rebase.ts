import type { Review, ReviewChange } from "../model/review";
import { ReviewError } from "../model/errors";
import { sha256 } from "../model/hash";
import { splitLinesPreserveEndings } from "../diff/text-lines";
import { myersDiff } from "../vendor/jsdiff/myers";
import type { ConflictInspection } from "./check";

interface LineEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: readonly string[];
  readonly source: "current" | "proposal";
}

export interface RebaseResult {
  readonly clean: boolean;
  readonly change?: ReviewChange;
  readonly overlappingRanges?: readonly {
    readonly current: { readonly start: number; readonly end: number };
    readonly proposal: { readonly start: number; readonly end: number };
  }[];
}

/**
 * Reconciles an externally changed review while giving the current Vault
 * content priority over overlapping proposal edits. A human edit in the
 * document always wins: disjoint agent edits are merged on top of it, and an
 * overlap keeps the current content as the new baseline instead of leaving the
 * review stuck in a conflicted state.
 */
export function reconcileReviewWithCurrentPriority(
  review: Review,
  inspection: ConflictInspection,
  now = new Date().toISOString(),
): Review {
  const conflictByChange = new Map<string, readonly string[]>();
  for (const conflict of inspection.conflicts) {
    const reasons = conflictByChange.get(conflict.changeId) ?? [];
    conflictByChange.set(conflict.changeId, [...reasons, conflict.reason]);
  }

  const changes = review.changes.map((change) => {
    const snapshot = inspection.snapshots.get(change.id);
    const reasons = conflictByChange.get(change.id);
    if (snapshot === undefined || reasons === undefined) return change;
    if (reasons.some((reason) => reason !== "base-changed")) {
      return preserveCurrentContent(change, snapshot.currentContent);
    }
    return rebaseChangeWithCurrentPriority(change, snapshot.currentContent);
  });
  const { conflict: _conflict, ...withoutConflict } = review;
  return {
    ...withoutConflict,
    status: "pending",
    revision: review.revision + 1,
    updatedAt: now,
    changes,
  };
}

/**
 * Rebases disjoint agent edits onto the current document and drops only the
 * overlapping edits when a safe merge is impossible.
 */
export function rebaseChangeWithCurrentPriority(
  change: ReviewChange,
  currentContent: string | null,
): ReviewChange {
  if (currentContent === null) return preserveCurrentContent(change, null);
  const result = rebaseChange(change, currentContent);
  return result.clean && result.change !== undefined
    ? result.change
    : preserveCurrentContent(change, currentContent);
}

/**
 * Adopts the current document as both base and proposal, which makes the human
 * edit the authoritative content and clears any hunk decisions that no longer
 * apply.
 */
function preserveCurrentContent(
  change: ReviewChange,
  currentContent: string | null,
): ReviewChange {
  const { newTarget: _newTarget, ...withoutNewTarget } = change;
  if (currentContent === null) {
    return {
      ...withoutNewTarget,
      operation: "delete",
      baseHash: null,
      baseContent: null,
      proposalContent: null,
      proposalHash: null,
      hunkDecisions: {},
    };
  }
  return {
    ...withoutNewTarget,
    operation: "modify",
    baseHash: sha256(currentContent),
    baseContent: currentContent,
    proposalContent: currentContent,
    proposalHash: sha256(currentContent),
    hunkDecisions: {},
  };
}

/**
 * Conservative line-based three-way rebase. It auto-merges only when edits from
 * current and proposal touch disjoint base intervals. Overlap is returned to the
 * caller and never resolved heuristically or silently.
 */
export function rebaseChange(
  change: ReviewChange,
  currentContent: string,
): RebaseResult {
  if (change.baseContent === null || change.proposalContent === null) {
    throw new ReviewError(
      "REBASE_CONFLICT",
      `Change ${change.id} does not have a three-way merge base and proposal.`,
      { changeId: change.id, operation: change.operation },
    );
  }
  if (currentContent === change.baseContent) {
    return {
      clean: true,
      change: {
        ...change,
        baseHash: sha256(currentContent),
        baseContent: currentContent,
      },
    };
  }
  if (change.proposalContent === change.baseContent) {
    return {
      clean: true,
      change: {
        ...change,
        baseHash: sha256(currentContent),
        baseContent: currentContent,
        proposalContent: currentContent,
        proposalHash: sha256(currentContent),
        hunkDecisions: {},
      },
    };
  }
  if (currentContent === change.proposalContent) {
    return {
      clean: true,
      change: {
        ...change,
        baseHash: sha256(currentContent),
        baseContent: currentContent,
        proposalContent: currentContent,
        proposalHash: sha256(currentContent),
        hunkDecisions: {},
      },
    };
  }

  const baseLines = splitLinesPreserveEndings(change.baseContent);
  const currentEdits = extractEdits(baseLines, splitLinesPreserveEndings(currentContent), "current");
  const proposalEdits = extractEdits(
    baseLines,
    splitLinesPreserveEndings(change.proposalContent),
    "proposal",
  );

  const overlaps: {
    current: { start: number; end: number };
    proposal: { start: number; end: number };
  }[] = [];
  for (const current of currentEdits) {
    for (const proposal of proposalEdits) {
      if (editsOverlap(current, proposal) && !editsEqual(current, proposal)) {
        overlaps.push({
          current: { start: current.start, end: current.end },
          proposal: { start: proposal.start, end: proposal.end },
        });
      }
    }
  }
  if (overlaps.length > 0) return { clean: false, overlappingRanges: overlaps };

  const combined = deduplicateEdits([...currentEdits, ...proposalEdits]);
  const mergedLines = applyEdits(baseLines, combined);
  const merged = mergedLines.join("");
  return {
    clean: true,
    change: {
      ...change,
      baseHash: sha256(currentContent),
      baseContent: currentContent,
      proposalContent: merged,
      proposalHash: sha256(merged),
      hunkDecisions: {},
    },
  };
}

function extractEdits(
  base: readonly string[],
  next: readonly string[],
  source: LineEdit["source"],
): readonly LineEdit[] {
  const components = myersDiff(base, next, { timeoutMs: 2_000 });
  if (components === undefined) {
    throw new ReviewError("REBASE_CONFLICT", "Three-way diff exceeded safety limits.");
  }
  const edits: LineEdit[] = [];
  let basePosition = 0;
  let active: { start: number; end: number; replacement: string[] } | undefined;
  const flush = (): void => {
    if (active === undefined) return;
    edits.push({ ...active, source });
    active = undefined;
  };

  for (const component of components) {
    if (!component.added && !component.removed) {
      flush();
      basePosition += component.values.length;
      continue;
    }
    active ??= { start: basePosition, end: basePosition, replacement: [] };
    if (component.removed) {
      active.end += component.values.length;
      basePosition += component.values.length;
    } else {
      active.replacement.push(...component.values);
    }
  }
  flush();
  return edits;
}

function editsOverlap(left: LineEdit, right: LineEdit): boolean {
  const leftInsert = left.start === left.end;
  const rightInsert = right.start === right.end;
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) return left.start >= right.start && left.start <= right.end;
  if (rightInsert) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function editsEqual(left: LineEdit, right: LineEdit): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.replacement.join("") === right.replacement.join("")
  );
}

function deduplicateEdits(edits: readonly LineEdit[]): readonly LineEdit[] {
  const result: LineEdit[] = [];
  for (const edit of edits) {
    if (!result.some((candidate) => editsEqual(candidate, edit))) result.push(edit);
  }
  return result;
}

function applyEdits(base: readonly string[], edits: readonly LineEdit[]): string[] {
  const result = [...base];
  const ordered = [...edits].sort((left, right) => {
    if (left.start !== right.start) return right.start - left.start;
    return right.end - left.end;
  });
  for (const edit of ordered) {
    result.splice(edit.start, edit.end - edit.start, ...edit.replacement);
  }
  return result;
}
