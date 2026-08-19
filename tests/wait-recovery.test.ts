import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ReviewError,
  ReviewService,
  recoverTransactions,
  reviewLayout,
  waitForReview,
  writeJournal,
  type TransactionJournal,
} from "../packages/core/src/index";
import { cleanupVault, createVault, readVaultFile, writeVaultFile } from "./helpers";

test("wait uses filesystem events and returns when review is rejected", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    const waitOne = waitForReview(service.store, review.id, { timeoutMs: 2_000 });
    const waitTwo = waitForReview(service.store, review.id, { timeoutMs: 2_000 });
    setTimeout(() => {
      void service.reject(review.id).catch(() => undefined);
    }, 75);
    const [first, second] = await Promise.all([waitOne, waitTwo]);
    assert.equal(first.status, "rejected");
    assert.equal(second.status, "rejected");
    assert.equal(await readVaultFile(vault, "note.md"), "base\n");
  } finally {
    await cleanupVault(vault);
  }
});

test("wait has a stable timeout error", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    await assert.rejects(
      waitForReview(service.store, review.id, { timeoutMs: 40 }),
      (error: unknown) => error instanceof ReviewError && error.code === "WAIT_TIMEOUT",
    );
  } finally {
    await cleanupVault(vault);
  }
});

test("crash recovery rolls back an applying transaction before normal startup", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    const transactionId = `${review.id}-crash-test`;
    const txDirectory = path.join(reviewLayout(vault).transactions, transactionId);
    const backupPath = path.join(txDirectory, "backups", "0001-target");
    const stagePath = path.join(txDirectory, "staged", "0001.new");
    const targetPath = path.join(vault, "note.md");
    await mkdir(path.dirname(backupPath), { recursive: true });
    await mkdir(path.dirname(stagePath), { recursive: true });
    await rename(targetPath, backupPath);
    await writeFile(targetPath, "proposal\n", "utf8");

    const journal: TransactionJournal = {
      schemaVersion: 1,
      transactionId,
      reviewId: review.id,
      createdAt: new Date().toISOString(),
      phase: "applying",
      committedChangeIds: ["0001"],
      entries: [
        {
          changeId: "0001",
          operation: "modify",
          target: "note.md",
          targetPath,
          originalTargetExisted: true,
          stagePath,
          backupPath,
        },
      ],
    };
    await writeJournal(txDirectory, journal);
    const recovered = await recoverTransactions(service.store);
    assert.equal(recovered[0]?.action, "rolled-back");
    assert.equal(await readVaultFile(vault, "note.md"), "base\n");
    assert.equal((await service.get(review.id)).status, "pending");
  } finally {
    await cleanupVault(vault);
  }
});

test("recovery preserves backups for a durably approved transaction before cleanup", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const submitted = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    const transactionId = `${submitted.id}-approved-cleanup`;
    const txDirectory = path.join(reviewLayout(vault).transactions, transactionId);
    const backupPath = path.join(txDirectory, "backups", "0001-target");
    const stagePath = path.join(txDirectory, "staged", "0001.new");
    const targetPath = path.join(vault, "note.md");
    await mkdir(path.dirname(backupPath), { recursive: true });
    await mkdir(path.dirname(stagePath), { recursive: true });
    await rename(targetPath, backupPath);
    await writeFile(targetPath, "proposal\n", "utf8");

    const approved = {
      ...submitted,
      status: "approved" as const,
      revision: submitted.revision + 1,
      updatedAt: new Date().toISOString(),
      changes: submitted.changes.map((change) => ({
        ...change,
        resultHash: change.proposalHash,
      })),
      decision: {
        kind: "approved" as const,
        at: new Date().toISOString(),
      },
    };
    await service.store.archive(approved);

    const journal: TransactionJournal = {
      schemaVersion: 1,
      transactionId,
      reviewId: submitted.id,
      createdAt: new Date().toISOString(),
      phase: "applying",
      committedChangeIds: ["0001"],
      entries: [
        {
          changeId: "0001",
          operation: "modify",
          target: "note.md",
          targetPath,
          originalTargetExisted: true,
          stagePath,
          backupPath,
        },
      ],
    };
    await writeJournal(txDirectory, journal);

    const recovered = await recoverTransactions(service.store);
    assert.equal(recovered[0]?.action, "cleaned-committed");
    assert.equal(await readVaultFile(vault, "note.md"), "proposal\n");
    assert.equal(
      await readVaultFile(
        vault,
        `.obsreview/trash/${submitted.id}/.backups/0001/target`,
      ),
      "base\n",
    );
  } finally {
    await cleanupVault(vault);
  }
});
