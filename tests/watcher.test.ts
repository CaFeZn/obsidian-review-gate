import test from "node:test";
import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReviewService, pendingReviewDirectory } from "../packages/core/src/index";
import { ReviewWatcher } from "../packages/obsidian-plugin/src/watcher/review-watcher";
import { cleanupVault, createVault, writeVaultFile } from "./helpers";

test("proposal watcher observes atomic external saves and service reconciles revision", async () => {
  const vault = await createVault();
  let watcher: ReviewWatcher | null = null;
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    let resolveEvent: (() => void) | undefined;
    const event = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    watcher = new ReviewWatcher(vault, () => resolveEvent?.(), { debounceMs: 20 });
    await watcher.start();
    const proposalPath = path.join(
      pendingReviewDirectory(vault, review.id),
      "changes",
      "0001",
      "proposal.md",
    );
    const temporary = `${proposalPath}.external-tmp`;
    await writeFile(temporary, "external proposal\n", "utf8");
    await rename(temporary, proposalPath);
    await Promise.race([
      event,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("watcher event timeout")), 2_000),
      ),
    ]);
    const reconciled = await service.get(review.id);
    assert.equal(reconciled.revision, 2);
    assert.equal(reconciled.changes[0]?.proposalContent, "external proposal\n");
  } finally {
    watcher?.stop();
    await cleanupVault(vault);
  }
});

test("target watcher marker is advisory while status remains pending", async () => {
  const vault = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "proposal\n" }],
    });
    await writeVaultFile(vault, "note.md", "external\n");
    const marked = await service.markPotentialConflict(review.id);
    assert.equal(marked.status, "pending");
    assert.equal(marked.conflict?.advisory, true);
  } finally {
    await cleanupVault(vault);
  }
});
