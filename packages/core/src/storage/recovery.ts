import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ReviewStore } from "./review-store";
import { reviewLayout } from "./layout";
import {
  preserveTransactionBackups,
  readJournal,
  rollbackEntries,
  writeJournal,
  type TransactionJournal,
} from "../patch/apply";
import { errorMessage } from "../model/errors";

export interface RecoveryItem {
  readonly transactionId: string;
  readonly action: "cleaned-committed" | "rolled-back" | "left-for-manual-recovery";
  readonly errors: readonly string[];
}

export async function recoverTransactions(
  store: ReviewStore,
): Promise<readonly RecoveryItem[]> {
  await store.initialize();
  const root = reviewLayout(store.vaultRoot).transactions;
  const results: RecoveryItem[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    let journal: TransactionJournal;
    try {
      journal = await readJournal(directory, store.vaultRoot);
    } catch (error) {
      results.push({
        transactionId: entry.name,
        action: "left-for-manual-recovery",
        errors: [errorMessage(error)],
      });
      continue;
    }

    try {
      const review = await store.load(journal.reviewId);
      if (review.status === "approved" || journal.phase === "committed") {
        try {
          await preserveTransactionBackups(
            store.vaultRoot,
            journal.reviewId,
            journal.entries,
          );
          await rm(directory, { recursive: true, force: true });
          results.push({
            transactionId: journal.transactionId,
            action: "cleaned-committed",
            errors: [],
          });
        } catch (error) {
          results.push({
            transactionId: journal.transactionId,
            action: "left-for-manual-recovery",
            errors: [errorMessage(error)],
          });
        }
        continue;
      }
    } catch {
      // Missing/corrupt review cannot prove commit. The safest default is rollback.
    }

    const errors = await rollbackEntries([...journal.entries].reverse());
    if (errors.length === 0) {
      await writeJournal(directory, { ...journal, phase: "rolled-back" }).catch(
        () => undefined,
      );
      await rm(directory, { recursive: true, force: true });
      results.push({
        transactionId: journal.transactionId,
        action: "rolled-back",
        errors: [],
      });
    } else {
      results.push({
        transactionId: journal.transactionId,
        action: "left-for-manual-recovery",
        errors,
      });
    }
  }
  return results;
}
