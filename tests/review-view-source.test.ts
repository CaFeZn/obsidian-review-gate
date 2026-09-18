import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("batch submission control shares the final approval footer", async () => {
  const source = await readFile(
    path.join(process.cwd(), "packages", "obsidian-plugin", "src", "ui", "review-view.ts"),
    "utf8",
  );
  const footerIndex = source.indexOf(
    'const footer = this.contentEl.createDiv({ cls: "obsreview-final-actions" });',
  );
  const batchIndex = source.indexOf(
    'addButton(footer, t("submitAcceptedBlocks")',
    footerIndex,
  );
  const approveIndex = source.indexOf(
    'addButton(footer, t("approveReview")',
    batchIndex,
  );

  assert.notEqual(footerIndex, -1);
  assert.ok(batchIndex > footerIndex);
  assert.ok(approveIndex > batchIndex);
  assert.match(
    source.slice(footerIndex, approveIndex),
    /if \(hasAcceptedHunks\(review\)\)[\s\S]*?onlyAccepted: true/u,
  );
  assert.match(source, /function hasAcceptedHunks\(review: Review\)/u);
});
