import assert from "node:assert/strict";
import test from "node:test";
import { JsDiffEngine } from "../packages/core/src/diff/jsdiff-engine";
import type { Review, ReviewChange } from "../packages/core/src/model/review";
import {
  NativeEditorCoordinator,
  type NativeEditorPair,
  type NativeEditorPairRequest,
} from "../packages/obsidian-plugin/src/editor/native-editor-coordinator";

test("native editor reuses its pair and routes proposal header commands", async () => {
  const givenChange = editableChange();
  const givenReview = reviewWith(givenChange);
  const requests: NativeEditorPairRequest[] = [];
  const calls: string[] = [];
  let revealCount = 0;
  let closeCount = 0;
  const pair: NativeEditorPair = {
    isOpen: () => true,
    reveal: async () => {
      revealCount += 1;
    },
    focusHunk: () => undefined,
    close: () => {
      closeCount += 1;
    },
  };
  const coordinator = new NativeEditorCoordinator({
    service: {
      diffEngine: new JsDiffEngine(),
      updateProposal: async () => givenReview,
      decideHunk: async () => givenReview,
      approve: async () => ({ review: givenReview, transactionId: "transaction" }),
    },
    operations: {
      save: async () => {
        calls.push("save");
        return givenReview;
      },
      decide: async (_session, command) => {
        calls.push(`decide:${command.hunkIndex}:${command.decision}`);
        return { review: givenReview, hunkIndex: 2 };
      },
      approve: async () => {
        calls.push("approve");
        return { review: givenReview, transactionId: "transaction" };
      },
    },
    createPair: async (request) => {
      requests.push(request);
      return pair;
    },
  });

  await coordinator.open(givenReview, givenChange);
  await coordinator.open(givenReview, givenChange);
  const request = requests[0];
  assert.ok(request);
  await request.onSave("edited proposal\n");
  const update = await request.onDecideHunk("edited proposal\n", 1, "rejected");
  const approved = await request.onApprove("edited proposal\n");
  coordinator.closeApproved(givenReview.id);

  assert.equal(requests.length, 1);
  assert.equal(revealCount, 2);
  assert.deepEqual(calls, ["save", "decide:1:rejected", "approve"]);
  assert.deepEqual(update, { proposalContent: "edited proposal\n", hunkIndex: 2 });
  assert.equal(approved, true);
  assert.equal(closeCount, 1);
});

function editableChange(): ReviewChange {
  return {
    id: "0001",
    operation: "modify",
    target: "notes/review.md",
    baseHash: "base-hash",
    baseContent: "base\n",
    proposalContent: "proposal\n",
    proposalHash: "proposal-hash",
    hunkDecisions: {},
  };
}

function reviewWith(change: ReviewChange): Review {
  return {
    schemaVersion: 1,
    id: "01M0HF4S6N128EBYSQACTNPHC2",
    status: "pending",
    revision: 3,
    createdAt: "2026-08-21T06:11:46.003Z",
    updatedAt: "2026-08-21T06:26:39.200Z",
    changes: [change],
  };
}
