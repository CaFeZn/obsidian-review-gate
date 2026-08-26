import assert from "node:assert/strict";
import test from "node:test";
import { JsDiffEngine } from "../packages/core/src/diff/jsdiff-engine";
import { ReviewError } from "../packages/core/src/model/errors";
import type { Review, ReviewChange } from "../packages/core/src/model/review";
import type { ApplyResult } from "../packages/core/src/patch/apply";
import type {
  HunkDecisionInput,
  UpdateProposalInput,
} from "../packages/core/src/service/review-service";
import {
  ReviewEditingSession,
  type ReviewSessionService,
} from "../packages/obsidian-plugin/src/editor/review-editing-session";

test("dirty hunk decisions save first and use the recalculated hunk revision", async () => {
  // Given: a pending review whose current proposal has an unsaved edit.
  const base = "one\nold\nthree\n";
  const draft = "one\nnew draft\nthree\n";
  const harness = createHarness(reviewWith([changeWith("0001", base, "one\nnew\nthree\n")], 7));
  const session = new ReviewEditingSession(harness.service, harness.review());
  session.updateDraft("0001", draft);

  // When: the highlighted hunk is accepted from the editor toolbar.
  await session.decideHunk("0001", 0, "accepted");

  // Then: saving advances the revision and the decision uses the new hunk ID.
  assert.deepEqual(harness.calls(), ["save:0001:7", "hunk:0001:8"]);
  assert.equal(
    harness.hunkInputs()[0]?.hunkId,
    harness.service.diffEngine.diff(base, draft).hunks[0]?.id,
  );
});

test("a save conflict preserves the draft and stops the hunk decision", async () => {
  // Given: a dirty proposal whose revision-safe save will conflict.
  const review = reviewWith([changeWith("0001", "base\n", "proposal\n")], 4);
  const harness = createHarness(review, true);
  const session = new ReviewEditingSession(harness.service, review);
  session.updateDraft("0001", "local draft\n");

  // When: accepting the hunk attempts the required automatic save.
  await assert.rejects(session.decideHunk("0001", 0, "accepted"), ReviewError);

  // Then: no stale hunk command runs and the local draft remains dirty.
  assert.deepEqual(harness.calls(), ["save:0001:4"]);
  assert.equal(session.proposal("0001"), "local draft\n");
  assert.equal(session.isDirty("0001"), true);
});

test("approval saves every dirty file and uses the latest revision", async () => {
  // Given: two changed files with independent unsaved drafts.
  const review = reviewWith([
    changeWith("0001", "base one\n", "proposal one\n"),
    changeWith("0002", "base two\n", "proposal two\n"),
  ], 2);
  const harness = createHarness(review);
  const session = new ReviewEditingSession(harness.service, review);
  session.updateDraft("0001", "draft one\n");
  session.updateDraft("0002", "draft two\n");

  // When: the review is approved from the editor toolbar.
  await session.approve();

  // Then: both drafts are saved in review order before approval uses revision four.
  assert.deepEqual(harness.calls(), ["save:0001:2", "save:0002:3", "approve:4"]);
});

interface Harness {
  readonly service: ReviewSessionService;
  review(): Review;
  calls(): readonly string[];
  hunkInputs(): readonly HunkDecisionInput[];
}

function createHarness(initialReview: Review, conflictOnSave = false): Harness {
  const diffEngine = new JsDiffEngine();
  const calls: string[] = [];
  const hunkInputs: HunkDecisionInput[] = [];
  let currentReview = initialReview;
  const service: ReviewSessionService = {
    diffEngine,
    updateProposal: async (_reviewId: string, input: UpdateProposalInput) => {
      calls.push(`save:${input.changeId}:${input.expectedRevision ?? -1}`);
      if (conflictOnSave) {
        throw new ReviewError("REVISION_CONFLICT", "conflict");
      }
      currentReview = replaceProposal(currentReview, input);
      return currentReview;
    },
    decideHunk: async (_reviewId: string, input: HunkDecisionInput) => {
      calls.push(`hunk:${input.changeId}:${input.expectedRevision ?? -1}`);
      hunkInputs.push(input);
      currentReview = { ...currentReview, revision: currentReview.revision + 1 };
      return currentReview;
    },
    approve: async (_reviewId, options): Promise<ApplyResult> => {
      calls.push(`approve:${options?.expectedRevision ?? -1}`);
      return { review: currentReview, transactionId: "transaction" };
    },
  };
  return {
    service,
    review: () => currentReview,
    calls: () => calls,
    hunkInputs: () => hunkInputs,
  };
}

function replaceProposal(review: Review, input: UpdateProposalInput): Review {
  return {
    ...review,
    revision: review.revision + 1,
    changes: review.changes.map((change) =>
      change.id === input.changeId
        ? {
            ...change,
            proposalContent: input.proposalContent,
            proposalHash: `hash-${review.revision + 1}`,
          }
        : change,
    ),
  };
}

function changeWith(id: string, baseContent: string, proposalContent: string): ReviewChange {
  return {
    id,
    operation: "modify",
    target: `${id}.md`,
    baseHash: `base-${id}`,
    baseContent,
    proposalContent,
    proposalHash: `proposal-${id}`,
    hunkDecisions: {},
  };
}

function reviewWith(changes: readonly ReviewChange[], revision: number): Review {
  return {
    schemaVersion: 1,
    id: "01M0HF4S6N128EBYSQACTNPHC2",
    status: "pending",
    revision,
    createdAt: "2026-08-21T06:11:46.003Z",
    updatedAt: "2026-08-21T06:26:39.200Z",
    changes,
  };
}
