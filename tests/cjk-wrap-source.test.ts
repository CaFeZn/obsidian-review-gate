import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("all review text surfaces use the shared CJK wrap range rule", async () => {
  // Given: the native editor, hunk renderer, and file selector sources.
  const sourceRoot = path.join(
    process.cwd(),
    "packages",
    "obsidian-plugin",
    "src",
  );
  const [nativeSource, hunkSource, reviewSource] = await Promise.all([
    readFile(path.join(sourceRoot, "editor", "native-cjk-word-decorations.ts"), "utf8"),
    readFile(path.join(sourceRoot, "ui", "diff-renderer.ts"), "utf8"),
    readFile(path.join(sourceRoot, "ui", "review-view.ts"), "utf8"),
  ]);

  // When: each rendering entry point is inspected.
  const sharedRule = /findCjkWrapRanges/u;

  // Then: all three surfaces delegate semantic boundaries to the same rule.
  assert.match(nativeSource, sharedRule);
  assert.match(hunkSource, sharedRule);
  assert.match(reviewSource, /renderCjkWrappedText/u);
});
