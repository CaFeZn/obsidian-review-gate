import type { ReviewChange, HunkDecisionKind } from "../model/review";
import { ReviewError } from "../model/errors";
import { sha256 } from "../model/hash";
import type { DiffEngine } from "../diff/types";
import { splitLinesPreserveEndings } from "../diff/text-lines";

export function applyHunkDecision(
  change: ReviewChange,
  hunkId: string,
  decision: HunkDecisionKind,
  engine: DiffEngine,
  now = new Date(),
): ReviewChange {
  if (change.proposalContent === null || change.operation === "delete") {
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      `Hunk operations require editable proposal content for change ${change.id}.`,
      { changeId: change.id, operation: change.operation },
    );
  }
  const baseContent = change.baseContent ?? "";

  const diff = engine.diff(baseContent, change.proposalContent);
  const hunk = diff.hunks.find((candidate) => candidate.id === hunkId);
  if (hunk === undefined) {
    throw new ReviewError(
      "CHANGE_NOT_FOUND",
      `Hunk no longer exists in the current proposal: ${hunkId}`,
      { changeId: change.id, hunkId },
    );
  }

  let proposalContent = change.proposalContent;
  if (decision === "rejected") {
    const proposalLines = splitLinesPreserveEndings(proposalContent);
    const baseLines = splitLinesPreserveEndings(hunk.baseSegment);
    proposalLines.splice(
      hunk.proposalStartIndex,
      hunk.proposalLineCount,
      ...baseLines,
    );
    proposalContent = proposalLines.join("");
  }

  return {
    ...change,
    proposalContent,
    proposalHash: sha256(proposalContent),
    hunkDecisions: {
      ...change.hunkDecisions,
      [hunkId]: {
        decision,
        at: now.toISOString(),
        baseHash: diff.baseHash,
        proposalHash: diff.proposalHash,
      },
    },
  };
}
