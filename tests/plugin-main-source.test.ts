import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("review queue stays in the sidebar while native review leaves own the diff", async () => {
  const givenPluginSource = await readPluginSource("main.ts");

  assert.match(givenPluginSource, /getRightLeaf\(false\)/u);
  assert.match(givenPluginSource, /new NativeEditorCoordinator/u);
  assert.match(givenPluginSource, /createNativeMarkdownPair/u);
  assert.match(givenPluginSource, /registerEditorExtension\(nativeDiffEditorExtension\)/u);
  assert.doesNotMatch(givenPluginSource, /ReviewSessionView/u);
  assert.doesNotMatch(givenPluginSource, /REVIEW_SESSION_VIEW_TYPE/u);
  assert.doesNotMatch(givenPluginSource, /migrateLegacyQueueView/u);
});

test("review watcher refreshes the queue and closes an approved native pair", async () => {
  const givenPluginSource = await readPluginSource("main.ts");

  const watcherStart = givenPluginSource.indexOf("this.watcher = new ReviewWatcher");
  const activeReviewIndex = givenPluginSource.indexOf("nativeEditor.activeReviewId()", watcherStart);
  const closeApprovedIndex = givenPluginSource.indexOf(
    "nativeEditor.closeApproved(review.id)",
    activeReviewIndex,
  );
  const refreshIndex = givenPluginSource.indexOf("await this.refreshViews()", closeApprovedIndex);

  assert.notEqual(watcherStart, -1);
  assert.ok(activeReviewIndex > watcherStart);
  assert.ok(closeApprovedIndex > activeReviewIndex);
  assert.ok(refreshIndex > closeApprovedIndex);
});

async function readPluginSource(filename: string): Promise<string> {
  return readFile(
    path.join(process.cwd(), "packages", "obsidian-plugin", "src", filename),
    "utf8",
  );
}
