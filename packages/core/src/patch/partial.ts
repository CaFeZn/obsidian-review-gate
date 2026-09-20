import type { ReviewChange } from "../model/review";
import { sha256 } from "../model/hash";
import { splitLinesPreserveEndings } from "../diff/text-lines";
import type { DiffEngine, DiffHunk } from "../diff/types";

export interface PartialCommitPlan {
  /**
   * Changes to write now. Their proposal content already reflects exactly the
   * accepted hunks, so a normal apply is safe.
   */
  readonly commit: readonly ReviewChange[];
  /**
   * Changes that stay pending, rebased onto the partially written content so the
   * remaining reading starts from what is already committed.
   */
  readonly remnant: readonly ReviewChange[];
}

/**
 * Splits a review into the part the reader has accepted and the part still to
 * review, so a long change can be submitted in batches.
 *
 * A hunk is written only when its decision is `accepted`. Undecided hunks stay
 * pending, and a rejected hunk is already absent from the proposal. Changes that
 * have no accept decision at all are left untouched, and changes without an
 * editable proposal (create, delete, rename) are never partly written because
 * they have no hunk granularity.
 */
export function planPartialCommit(
  changes: readonly ReviewChange[],
  engine: DiffEngine,
): PartialCommitPlan {
  const commit: ReviewChange[] = [];
  const remnant: ReviewChange[] = [];

  for (const change of changes) {
    if (change.proposalContent === null || change.operation === "delete") {
      remnant.push(change);
      continue;
    }
    const baseContent = change.baseContent ?? "";
    const diff = engine.diff(baseContent, change.proposalContent, { contextLines: 0 });
    const accepted = diff.hunks.filter(
      (hunk) => change.hunkDecisions[hunk.id]?.decision === "accepted",
    );
    if (accepted.length === 0) {
      remnant.push(change);
      continue;
    }
    if (accepted.length === diff.hunks.length) {
      // Every hunk was accepted, so this change is no longer partial.
      commit.push(change);
      continue;
    }
    if (change.operation !== "modify") {
      // A create or rename has no meaningful partial state: writing part of a new
      // file and leaving the rest over would fail on the second apply because the
      // target then exists. These wait for a batch that accepts them whole.
      remnant.push(change);
      continue;
    }

    const partialContent = applyAcceptedHunks(baseContent, accepted);
    const partialHash = sha256(partialContent);
    commit.push({
      ...change,
      proposalContent: partialContent,
      proposalHash: partialHash,
      hunkDecisions: {},
    });
    // The remnant keeps the original proposal and adopts the written content as
    // its new base, so the remaining diff shows only the undecided hunks.
    remnant.push({
      ...change,
      baseContent: partialContent,
      baseHash: partialHash,
      hunkDecisions: {},
    });
  }

  return { commit, remnant };
}

/**
 * Rebuilds the document from its base with only the accepted hunks applied.
 * Hunks are spliced from the end so earlier indexes stay valid.
 */
function applyAcceptedHunks(
  baseContent: string,
  accepted: readonly DiffHunk[],
): string {
  const lines = splitLinesPreserveEndings(baseContent);
  const ordered = [...accepted].sort(
    (left, right) => right.baseStartIndex - left.baseStartIndex,
  );
  for (const hunk of ordered) {
    lines.splice(
      hunk.baseStartIndex,
      hunk.baseLineCount,
      ...splitLinesPreserveEndings(hunk.proposalSegment),
    );
  }
  return lines.join("");
}
