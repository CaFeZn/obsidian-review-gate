import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
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
          "proposal.md",
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
      "proposal.md",
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

test("approve detects external base change and never overwrites it", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "A\n");
    const service = await openService(vault);
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "B\n" }],
    });
    await writeVaultFile(vault, "note.md", "C\n");
    await assert.rejects(
      service.approve(review.id),
      (error: unknown) => error instanceof ReviewError && error.code === "REVIEW_CONFLICT",
    );
    assert.equal(await readVaultFile(vault, "note.md"), "C\n");
    const conflicted = await service.get(review.id);
    assert.equal(conflicted.status, "conflicted");
    assert.equal(conflicted.conflict?.advisory, false);
  } finally {
    await cleanupVault(vault);
  }
});

test("multi-file preflight prevents a half-commit", async () => {
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
    await assert.rejects(
      service.approve(review.id),
      (error: unknown) => error instanceof ReviewError && error.code === "REVIEW_CONFLICT",
    );
    assert.equal(await readVaultFile(vault, "A.md"), "A0\n");
    assert.equal(await readVaultFile(vault, "B.md"), "external\n");
    await assert.rejects(access(path.join(vault, "C.md")));
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
      await readFile(path.join(vault, ".obsreview", "trash", review.id, "Old.md"), "utf8"),
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

test("non-overlapping conflict can be rebased and then approved", async () => {
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
    await assert.rejects(service.approve(review.id));
    const conflicted = await service.get(review.id);
    const rebased = await service.rebase(review.id, {
      expectedRevision: conflicted.revision,
    });
    assert.equal(rebased.status, "pending");
    assert.equal(
      rebased.changes[0]?.proposalContent,
      "ONE\ntwo\nthree\nFOUR\n",
    );
    await service.approve(review.id, { expectedRevision: rebased.revision });
    assert.equal(await readVaultFile(vault, "note.md"), "ONE\ntwo\nthree\nFOUR\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("overlapping conflict remains conflicted after automatic rebase refusal", async () => {
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
    await assert.rejects(service.approve(review.id));
    const conflicted = await service.get(review.id);
    await assert.rejects(
      service.rebase(review.id, { expectedRevision: conflicted.revision }),
      (error: unknown) => error instanceof ReviewError && error.code === "REBASE_CONFLICT",
    );
    assert.equal((await service.get(review.id)).status, "conflicted");
    assert.equal(await readVaultFile(vault, "note.md"), "one\nCURRENT\nthree\n");
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
    const conflicted = await service.markPotentialConflict(review.id);
    await service.approve(review.id, {
      force: true,
      expectedRevision: conflicted.revision,
    });
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
    await writeFile(path.join(directory, "meta.json.tmp-crash"), "partial", "utf8");
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
