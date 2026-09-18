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
      submitAccepted: async () => {
        calls.push("submit-accepted");
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
  assert.equal(request.hasAcceptedHunks(), false);
  const submitted = await request.onSubmitAccepted("edited proposal\n");
  const approved = await request.onApprove("edited proposal\n");
  coordinator.closeApproved(givenReview.id);

  assert.equal(requests.length, 1);
  assert.equal(revealCount, 2);
  assert.deepEqual(calls, ["save", "decide:1:rejected", "submit-accepted", "approve"]);
  assert.deepEqual(update, { proposalContent: "edited proposal\n", hunkIndex: 2 });
  assert.equal(submitted, true);
  assert.equal(approved, true);
  assert.equal(closeCount, 1);
});

test("native editor reopens the latest proposal when changing layout", async () => {
  const givenChange = editableChange();
  const givenReview = reviewWith(givenChange);
  const updatedChange: ReviewChange = {
    ...givenChange,
    proposalContent: "edited proposal\n",
    proposalHash: "edited-proposal-hash",
  };
  const updatedReview = reviewWith(updatedChange, 4);
  const requests: NativeEditorPairRequest[] = [];
  const pairs: NativeEditorPair[] = [];

  const coordinator = new NativeEditorCoordinator({
    service: {
      diffEngine: new JsDiffEngine(),
      updateProposal: async () => updatedReview,
      decideHunk: async () => updatedReview,
      approve: async () => ({ review: updatedReview, transactionId: "transaction" }),
    },
    operations: {
      save: async (session, changeId) => session.saveChange(changeId),
      decide: async () => null,
      approve: async () => null,
      submitAccepted: async () => null,
    },
    createPair: async (request) => {
      requests.push(request);
      const pair: NativeEditorPair = {
        isOpen: () => true,
        reveal: async () => undefined,
        focusHunk: () => undefined,
        close: () => undefined,
      };
      pairs.push(pair);
      return pair;
    },
  });

  await coordinator.open(givenReview, givenChange);
  const firstRequest = requests[0];
  assert.ok(firstRequest);
  await firstRequest.onModeChange?.("unified", "edited proposal\n");

  const secondRequest = requests[1];
  assert.ok(secondRequest);
  assert.equal(secondRequest.mode, "unified");
  assert.equal(secondRequest.proposalContent, "edited proposal\n");
  assert.equal(pairs.length, 2);
});

test("native editor refreshes an active pair from the latest review revision", async () => {
  const givenChange = editableChange();
  const givenReview = reviewWith(givenChange);
  const updatedChange: ReviewChange = {
    ...givenChange,
    proposalContent: "latest proposal\n",
    proposalHash: "latest-proposal-hash",
  };
  const updatedReview = reviewWith(updatedChange, 4);
  const requests: NativeEditorPairRequest[] = [];

  const coordinator = new NativeEditorCoordinator({
    service: {
      diffEngine: new JsDiffEngine(),
      updateProposal: async () => updatedReview,
      decideHunk: async () => updatedReview,
      approve: async () => ({ review: updatedReview, transactionId: "transaction" }),
    },
    operations: {
      save: async () => updatedReview,
      decide: async () => null,
      approve: async () => null,
      submitAccepted: async () => null,
    },
    createPair: async (request) => {
      requests.push(request);
      return {
        isOpen: () => true,
        reveal: async () => undefined,
        focusHunk: () => undefined,
        close: () => undefined,
      };
    },
  });

  await coordinator.open(givenReview, givenChange);
  await coordinator.refresh(updatedReview);

  const refreshedRequest = requests[1];
  assert.ok(refreshedRequest);
  assert.equal(refreshedRequest.mode, "split");
  assert.equal(refreshedRequest.proposalContent, "latest proposal\n");
});

test("native editor does not refresh while a proposal mutation is in flight", async () => {
  const givenChange = editableChange();
  const givenReview = reviewWith(givenChange);
  const updatedReview = reviewWith(
    { ...givenChange, proposalContent: "latest proposal\n" },
    4,
  );
  const requests: NativeEditorPairRequest[] = [];
  let releaseSave: (() => void) | undefined;
  const saveStarted = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });

  const coordinator = new NativeEditorCoordinator({
    service: {
      diffEngine: new JsDiffEngine(),
      updateProposal: async () => updatedReview,
      decideHunk: async () => updatedReview,
      approve: async () => ({ review: updatedReview, transactionId: "transaction" }),
    },
    operations: {
      save: async () => {
        await saveStarted;
        return updatedReview;
      },
      decide: async () => null,
      approve: async () => null,
      submitAccepted: async () => null,
    },
    createPair: async (request) => {
      requests.push(request);
      return {
        isOpen: () => true,
        isDirty: () => false,
        reveal: async () => undefined,
        focusHunk: () => undefined,
        close: () => undefined,
      };
    },
  });

  await coordinator.open(givenReview, givenChange);
  const savePromise = requests[0]?.onSave("edited proposal\n");
  await Promise.resolve();
  assert.equal(await coordinator.refresh(updatedReview), false);
  releaseSave?.();
  await savePromise;
  assert.equal(requests.length, 1);
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

function reviewWith(change: ReviewChange, revision = 3): Review {
  return {
    schemaVersion: 1,
    id: "01M0HF4S6N128EBYSQACTNPHC2",
    status: "pending",
    revision,
    createdAt: "2026-08-21T06:11:46.003Z",
    updatedAt: "2026-08-21T06:26:39.200Z",
    changes: [change],
  };
}
