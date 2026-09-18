import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  JsDiffEngine,
  ReviewError,
  ReviewService,
  pendingReviewDirectory,
  reviewMetaPath,
  sha256,
  trashTargetPath,
} from "../packages/core/src/index";
import { cleanupVault, createVault, readVaultFile, writeVaultFile } from "./helpers";

async function openService(vault: string): Promise<ReviewService> {
  return (await ReviewService.open(vault)).service;
}

test("submit snapshots base but cannot mutate target", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "Framework/CAN.md", "A\n");
    const service = await openService(vault);
    const review = await service.submit({
      source: { agent: "codex", session: "s1" },
      changes: [
        {
          target: "Framework/CAN.md",
          proposalContent: "B\n",
        },
      ],
    });
    assert.equal(review.status, "pending");
    assert.equal(review.changes[0]?.operation, "modify");
    assert.equal(review.changes[0]?.baseHash, sha256("A\n"));
    assert.equal(await readVaultFile(vault, "Framework/CAN.md"), "A\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("review storage can live outside the vault while approval still writes the target", async () => {
  const vault = await createVault();
  const storageBase = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    await writeVaultFile(vault, "old.md", "recoverable\n");
    const service = (await ReviewService.open(vault, { storageBase })).service;
    const review = await service.submit({
      changes: [
        { target: "note.md", proposalContent: "approved\n" },
        { operation: "delete", target: "old.md" },
      ],
    });

    assert.equal(service.store.storageBase, path.resolve(storageBase));
    await assert.rejects(access(path.join(vault, ".obsreview")));
    assert.equal(
      await readFile(
        path.join(
          pendingReviewDirectory(storageBase, review.id),
          "changes",
          "0001",
          "proposal.rgdata",
        ),
        "utf8",
      ),
      "approved\n",
    );
    assert.equal(await readVaultFile(vault, "note.md"), "base\n");

    await service.approve(review.id);
    assert.equal(await readVaultFile(vault, "note.md"), "approved\n");
    await assert.rejects(access(path.join(vault, "old.md")));
    assert.equal(
      await readFile(trashTargetPath(storageBase, review.id, "old.md"), "utf8"),
      "recoverable\n",
    );
    await assert.rejects(access(pendingReviewDirectory(storageBase, review.id)));
    assert.equal((await service.get(review.id)).status, "approved");
  } finally {
    await cleanupVault(storageBase);
    await cleanupVault(vault);
  }
});

test("external proposal edit increments revision before an agent update", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal 1\n" }],
    });
    const proposalPath = path.join(
      pendingReviewDirectory(vault, review.id),
      "changes",
      "0001",
      "proposal.rgdata",
    );
    await writeFile(proposalPath, "human edit\n", "utf8");
    const reconciled = await service.get(review.id);
    assert.equal(reconciled.revision, 2);
    assert.equal(reconciled.changes[0]?.proposalContent, "human edit\n");
    await assert.rejects(
      service.updateProposal(review.id, {
        changeId: "0001",
        proposalContent: "agent overwrite\n",
        expectedRevision: 1,
      }),
      (error: unknown) => error instanceof ReviewError && error.code === "REVISION_CONFLICT",
    );
    assert.equal((await service.get(review.id)).changes[0]?.proposalContent, "human edit\n");
    assert.equal(await readVaultFile(vault, "note.md"), "base\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("two concurrent proposal updates cannot silently overwrite each other", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "first\n" }],
    });
    const updates = await Promise.allSettled([
      service.updateProposal(review.id, {
        changeId: "0001",
        proposalContent: "left\n",
        expectedRevision: 1,
      }),
      service.updateProposal(review.id, {
        changeId: "0001",
        proposalContent: "right\n",
        expectedRevision: 1,
      }),
    ]);
    assert.equal(updates.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = updates.find((item) => item.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof ReviewError);
    assert.equal(rejected.reason.code, "REVISION_CONFLICT");
    assert.equal((await service.get(review.id)).revision, 2);
  } finally {
    await cleanupVault(vault);
  }
});

test("approve keeps the external human edit and never overwrites it", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "A\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "B\n" }],
    });
    await writeVaultFile(vault, "note.md", "C\n");
    const result = await service.approve(review.id);
    assert.equal(result.review.status, "approved");
    assert.equal(await readVaultFile(vault, "note.md"), "C\n");
    const reconciled = await service.get(review.id);
    assert.equal(reconciled.status, "approved");
    assert.equal(reconciled.changes[0]?.baseContent, "C\n");
    assert.equal(reconciled.changes[0]?.proposalContent, "C\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("multi-file apply preserves the human-edited file while applying safe changes", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "A.md", "A0\n");
    await writeVaultFile(vault, "B.md", "B0\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [
        { target: "A.md", proposalContent: "A1\n" },
        { target: "B.md", proposalContent: "B1\n" },
        { operation: "create", target: "C.md", proposalContent: "C1\n" },
      ],
    });
    await writeVaultFile(vault, "B.md", "external\n");
    const result = await service.approve(review.id);
    assert.equal(result.review.status, "approved");
    assert.equal(await readVaultFile(vault, "A.md"), "A1\n");
    assert.equal(await readVaultFile(vault, "B.md"), "external\n");
    assert.equal(await readVaultFile(vault, "C.md"), "C1\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("successful multi-file approve applies modify/create/delete and archives history", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "A.md", "A0\n");
    await writeVaultFile(vault, "Old.md", "old\n");
    const service = await openService(vault);
    const review = await service.submit({
      source: { agent: "claude" },
      changes: [
        { target: "A.md", proposalContent: "A1\n" },
        { operation: "create", target: "New.md", proposalContent: "new\n" },
        { operation: "delete", target: "Old.md" },
      ],
    });
    assert.equal(await readVaultFile(vault, "A.md"), "A0\n");
    const result = await service.approve(review.id, { expectedRevision: 1 });
    assert.equal(result.review.status, "approved");
    assert.equal(await readVaultFile(vault, "A.md"), "A1\n");
    assert.equal(await readVaultFile(vault, "New.md"), "new\n");
    await assert.rejects(access(path.join(vault, "Old.md")));
    assert.equal(
      await readFile(trashTargetPath(vault, review.id, "Old.md"), "utf8"),
      "old\n",
    );
    await assert.rejects(access(pendingReviewDirectory(vault, review.id)));
    const history = await service.get(review.id);
    assert.equal(history.status, "approved");
    assert.equal(history.changes[0]?.resultHash, sha256("A1\n"));
  } finally {
    await cleanupVault(vault);
  }
});

test("rename is modeled and applied without deleting recoverability data", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "old/name.md", "base\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [
        {
          operation: "rename",
          target: "old/name.md",
          newTarget: "new/name.md",
          proposalContent: "renamed and edited\n",
        },
      ],
    });
    await service.approve(review.id);
    await assert.rejects(access(path.join(vault, "old", "name.md")));
    assert.equal(await readVaultFile(vault, "new/name.md"), "renamed and edited\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("hunk decisions through service never mutate target before approve", async () => {
  const vault = await createVault();
  try {
    const base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
    const proposal = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n";
    await writeVaultFile(vault, "note.md", base);
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: proposal }],
    });
    const diff = service.diffEngine.diff(base, proposal);
    const first = diff.hunks[0];
    assert.ok(first);
    const next = await service.decideHunk(review.id, {
      changeId: "0001",
      hunkId: first.id,
      decision: "rejected",
      expectedRevision: 1,
    });
    assert.equal(next.changes[0]?.proposalContent, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n");
    assert.equal(await readVaultFile(vault, "note.md"), base);
    await service.approve(review.id, { expectedRevision: 2 });
    assert.equal(await readVaultFile(vault, "note.md"), "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("non-overlapping conflict is rebased automatically and then approved", async () => {
  const vault = await createVault();
  try {
    const base = "one\ntwo\nthree\nfour\n";
    await writeVaultFile(vault, "note.md", base);
    const service = await openService(vault);
    const review = await service.submit({
      changes: [
        { target: "note.md", proposalContent: "ONE\ntwo\nthree\nfour\n" },
      ],
    });
    await writeVaultFile(vault, "note.md", "one\ntwo\nthree\nFOUR\n");
    const result = await service.approve(review.id);
    assert.equal(result.review.status, "approved");
    const rebased = await service.get(review.id);
    assert.equal(
      rebased.changes[0]?.proposalContent,
      "ONE\ntwo\nthree\nFOUR\n",
    );
    assert.equal(await readVaultFile(vault, "note.md"), "ONE\ntwo\nthree\nFOUR\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("overlapping conflict keeps the current human content and drops the overlap", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "one\ntwo\nthree\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [
        { target: "note.md", proposalContent: "one\nPROPOSAL\nthree\n" },
      ],
    });
    await writeVaultFile(vault, "note.md", "one\nCURRENT\nthree\n");
    const result = await service.approve(review.id);
    assert.equal(result.review.status, "approved");
    const reconciled = await service.get(review.id);
    assert.equal(reconciled.changes[0]?.baseContent, "one\nCURRENT\nthree\n");
    assert.equal(reconciled.changes[0]?.proposalContent, "one\nCURRENT\nthree\n");
    assert.equal(await readVaultFile(vault, "note.md"), "one\nCURRENT\nthree\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("submitting only accepted blocks writes a batch and keeps the rest pending", async () => {
  const vault = await createVault();
  try {
    // Given: a note with two distant changed regions in one proposal.
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const base = lines.map((line) => `${line}\n`).join("");
    const firstChanged = lines.map((line, index) => (index === 0 ? "A" : line));
    const bothChanged = firstChanged.map((line, index) => (index === 10 ? "K" : line));
    const proposal = bothChanged.map((line) => `${line}\n`).join("");
    await writeVaultFile(vault, "note.md", base);
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: proposal }],
    });

    // When: the reader accepts only the first block and submits that batch.
    const change = review.changes[0];
    assert.ok(change);
    const hunks = new JsDiffEngine().diff(base, proposal).hunks;
    assert.equal(hunks.length, 2);
    const firstHunk = hunks[0];
    assert.ok(firstHunk);
    await service.decideHunk(review.id, {
      changeId: change.id,
      hunkId: firstHunk.id,
      decision: "accepted",
      expectedRevision: review.revision,
    });
    const afterDecision = await service.get(review.id);
    const result = await service.approve(review.id, {
      onlyAccepted: true,
      expectedRevision: afterDecision.revision,
      actor: "obsidian-user",
    });

    // Then: only the accepted block reached the document.
    assert.equal(
      await readVaultFile(vault, "note.md"),
      lines.map((line, index) => (index === 0 ? "A" : line)).map((line) => `${line}\n`).join(""),
    );
    // And: the review is still pending, with the remaining block rebased onto
    // what was just written, so the next sitting continues from here.
    assert.equal(result.review.status, "pending");
    assert.equal(result.review.changes.length, 1);
    assert.equal(result.review.changes[0]?.baseContent, await readVaultFile(vault, "note.md"));
    assert.equal(result.review.changes[0]?.proposalContent, proposal);
    assert.deepEqual(result.review.changes[0]?.hunkDecisions, {});
  } finally {
    await cleanupVault(vault);
  }
});

test("a full batch of accepted blocks completes the review", async () => {
  const vault = await createVault();
  try {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const base = lines.map((line) => `${line}\n`).join("");
    const proposal = lines.map((line, index) => (index === 0 ? "A" : line)).map((line) => `${line}\n`).join("");
    await writeVaultFile(vault, "note.md", base);
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: proposal }],
    });
    const change = review.changes[0];
    assert.ok(change);
    const hunk = new JsDiffEngine().diff(base, proposal).hunks[0];
    assert.ok(hunk);
    await service.decideHunk(review.id, {
      changeId: change.id,
      hunkId: hunk.id,
      decision: "accepted",
      expectedRevision: review.revision,
    });
    const afterDecision = await service.get(review.id);

    // When: every block was accepted, the review finishes instead of staying open.
    const result = await service.approve(review.id, {
      onlyAccepted: true,
      expectedRevision: afterDecision.revision,
    });

    assert.equal(result.review.status, "approved");
    assert.equal(await readVaultFile(vault, "note.md"), proposal);
  } finally {
    await cleanupVault(vault);
  }
});

test("partial batches retain the earlier target backup for the review", async () => {
  const vault = await createVault();
  try {
    const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const base = lines.map((line) => `${line}\n`).join("");
    const proposal = lines
      .map((line, index) => (index === 0 ? "A" : index === 10 ? "K" : line))
      .map((line) => `${line}\n`)
      .join("");
    await writeVaultFile(vault, "note.md", base);
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: proposal }],
    });
    const change = review.changes[0];
    assert.ok(change);
    const diff = new JsDiffEngine().diff(base, proposal);
    const firstHunk = diff.hunks[0];
    assert.ok(firstHunk);

    await service.decideHunk(review.id, {
      changeId: change.id,
      hunkId: firstHunk.id,
      decision: "accepted",
      expectedRevision: review.revision,
    });
    const firstBatch = await service.approve(review.id, { onlyAccepted: true });
    assert.equal(firstBatch.review.status, "pending");
    const firstWritten = await readVaultFile(vault, "note.md");
    const backupDirectory = path.join(
      vault,
      ".obsreview",
      "trash",
      review.id,
      ".backups",
      change.id,
    );
    assert.equal(await readFile(path.join(backupDirectory, "target"), "utf8"), base);

    const pending = await service.get(review.id);
    const remainingChange = pending.changes[0];
    assert.ok(remainingChange);
    const remainingHunk = new JsDiffEngine()
      .diff(remainingChange.baseContent ?? "", remainingChange.proposalContent ?? "")
      .hunks[0];
    assert.ok(remainingHunk);
    await service.decideHunk(review.id, {
      changeId: remainingChange.id,
      hunkId: remainingHunk.id,
      decision: "accepted",
      expectedRevision: pending.revision,
    });
    const final = await service.approve(review.id, { onlyAccepted: true });

    assert.equal(final.review.status, "approved");
    assert.equal(await readVaultFile(vault, "note.md"), proposal);
    const backupNames = await readdir(backupDirectory);
    const retainedBatchBackups = backupNames.filter((name) => name.startsWith("target."));
    assert.equal(retainedBatchBackups.length, 1);
    assert.equal(
      await readFile(path.join(backupDirectory, retainedBatchBackups[0] as string), "utf8"),
      firstWritten,
    );
  } finally {
    await cleanupVault(vault);
  }
});

test("submitting with no accepted block is refused and writes nothing", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "one\ntwo\nthree\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "one\nTWO\nthree\n" }],
    });

    // When: nothing has been accepted yet.
    await assert.rejects(
      service.approve(review.id, { onlyAccepted: true }),
      (error: unknown) => error instanceof ReviewError && error.code === "INVALID_ARGUMENTS",
    );

    // Then: the target is untouched and the review still has its proposal.
    assert.equal(await readVaultFile(vault, "note.md"), "one\ntwo\nthree\n");
    const pending = await service.get(review.id);
    assert.equal(pending.status, "pending");
    assert.equal(pending.changes[0]?.proposalContent, "one\nTWO\nthree\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("force apply is explicit and preserves overwritten current content in trash backups", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    await writeVaultFile(vault, "note.md", "current\n");
    // Force apply still overwrites the current document with the proposal, so it
    // is exercised against a review the watcher has not already reconciled onto
    // the current content.
    await service.approve(review.id, { force: true });
    assert.equal(await readVaultFile(vault, "note.md"), "proposal\n");
    const backupRoot = path.join(vault, ".obsreview", "trash", review.id);
    const backupCandidates = [
      path.join(backupRoot, ".backups", "0001", "target"),
      path.join(backupRoot, ".backups", "0001", "target", "current"),
    ];
    let found = false;
    for (const candidate of backupCandidates) {
      try {
        if ((await readFile(candidate, "utf8")) === "current\n") found = true;
      } catch {
        // Try next layout candidate.
      }
    }
    // The current implementation nests backups beside the target's trash parent.
    if (!found) {
      const actual = path.join(backupRoot, ".backups", "0001", "target");
      found = (await readFile(actual, "utf8")) === "current\n";
    }
    assert.equal(found, true);
  } finally {
    await cleanupVault(vault);
  }
});

test("reject and cancel archive without writing targets", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "one.md", "one\n");
    await writeVaultFile(vault, "two.md", "two\n");
    const service = await openService(vault);
    const rejectReview = await service.submit({
      changes: [{ target: "one.md", proposalContent: "changed\n" }],
    });
    const cancelReview = await service.submit({
      changes: [{ target: "two.md", proposalContent: "changed\n" }],
    });
    assert.equal((await service.reject(rejectReview.id)).status, "rejected");
    assert.equal((await service.cancel(cancelReview.id)).status, "cancelled");
    assert.equal(await readVaultFile(vault, "one.md"), "one\n");
    assert.equal(await readVaultFile(vault, "two.md"), "two\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("corrupted metadata is rejected while crash-like temp files are ignored", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    const directory = pendingReviewDirectory(vault, review.id);
    await writeFile(path.join(directory, "meta.rgdata.tmp-crash"), "partial", "utf8");
    assert.equal((await service.get(review.id)).status, "pending");
    await writeFile(reviewMetaPath(directory), "{broken", "utf8");
    await assert.rejects(
      service.store.load(review.id),
      (error: unknown) => error instanceof ReviewError && error.code === "CORRUPTED_REVIEW",
    );
  } finally {
    await cleanupVault(vault);
  }
});
