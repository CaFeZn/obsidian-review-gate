import assert from "node:assert/strict";
import test from "node:test";
import type { Review, ReviewChange } from "../packages/core/src/model/review";
import {
  buildFileHistory,
  filterFileHistoryPaths,
} from "../packages/obsidian-plugin/src/history/file-history";

test("file history follows rename chains and lists each review once newest first", () => {
  const reviews = [
    review("01-create", "2026-08-20T08:00:00.000Z", [
      change("0001", "create", "notes/original.md"),
    ]),
    review("02-rename", "2026-08-21T08:00:00.000Z", [
      change("0001", "rename", "notes/original.md", "notes/renamed.md"),
    ]),
    review("03-modify", "2026-08-22T08:00:00.000Z", [
      change("0001", "modify", "notes/renamed.md"),
    ]),
    review("04-delete", "2026-08-23T08:00:00.000Z", [
      change("0001", "delete", "notes/renamed.md"),
    ], "cancelled"),
  ];

  const history = buildFileHistory(reviews);

  assert.deepEqual(history.paths, ["notes/original.md", "notes/renamed.md"]);
  assert.deepEqual(
    history.entriesFor("notes/renamed.md").map((entry) => entry.review.id),
    ["04-delete", "03-modify", "02-rename", "01-create"],
  );
  assert.deepEqual(
    history.entriesFor("notes/original.md").map((entry) => entry.review.id),
    ["04-delete", "03-modify", "02-rename", "01-create"],
  );
});

test("file history path search is case-insensitive and keeps deterministic order", () => {
  const paths = [
    "Projects/Archive/计划.md",
    "Projects/active.md",
    "Notes/archive-log.md",
  ];

  assert.deepEqual(filterFileHistoryPaths(paths, "ARCHIVE"), [
    "Notes/archive-log.md",
    "Projects/Archive/计划.md",
  ]);
});

function change(
  id: string,
  operation: ReviewChange["operation"],
  target: string,
  newTarget?: string,
): ReviewChange {
  return {
    id,
    operation,
    target,
    ...(newTarget === undefined ? {} : { newTarget }),
    baseHash: null,
    baseContent: null,
    proposalContent: null,
    proposalHash: null,
    hunkDecisions: {},
  };
}

function review(
  id: string,
  updatedAt: string,
  changes: readonly ReviewChange[],
  status: Review["status"] = "approved",
): Review {
  return {
    schemaVersion: 1,
    id,
    status,
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
    changes,
  };
}
