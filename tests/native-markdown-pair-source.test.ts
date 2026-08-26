import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("native Markdown review opens two adjacent leaves in the current window", async () => {
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");

  assert.match(
    givenPairSource,
    /createMainWindowReviewLeaves\(app\.workspace\)/u,
  );
  assert.doesNotMatch(givenPairSource, /openPopoutLeaf/u);
  assert.doesNotMatch(givenPairSource, /moveLeafToPopout/u);
  assert.doesNotMatch(givenPairSource, /\.win\.close/u);
});

test("proposal leaf header exposes save hunk navigation decisions and approval", async () => {
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");

  for (const key of [
    "saveProposal",
    "previousHunk",
    "nextHunk",
    "acceptHunk",
    "rejectHunk",
    "approveReview",
  ]) {
    assert.match(givenPairSource, new RegExp(`t\\("${key}"\\)`, "u"));
  }
  assert.match(givenPairSource, /request\.onDecideHunk/u);
  assert.match(givenPairSource, /request\.onApprove/u);
  assert.match(givenPairSource, /setAttribute\("role", "toolbar"\)/u);
  assert.match(
    givenPairSource,
    /setAttribute\("aria-label", t\("editableProposal"\)\)/u,
  );
});

test("proposal leaf header keeps every action visible when the native leaf is narrow", async () => {
  // Given: each proposal action and its toolbar have dedicated narrow-width styles.
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");
  const givenStyles = await readFile(
    path.join(process.cwd(), "packages", "obsidian-plugin", "styles.css"),
    "utf8",
  );

  // When: the native leaf becomes too narrow for all proposal actions.
  // Then: its named toolbar receives a wrapping layout instead of clipping actions.
  assert.match(
    givenPairSource,
    /classList\.add\("obsreview-native-proposal-toolbar"\)/u,
  );
  assert.match(
    givenPairSource,
    /classList\.add\("obsreview-native-proposal-action"\)/u,
  );
  assert.match(givenStyles, /container-name: obsreview-native-proposal/u);
  assert.match(
    givenStyles,
    /@container obsreview-native-proposal \(max-width: 520px\)[\s\S]*\.view-header-title-container[\s\S]*display: none[\s\S]*\.obsreview-native-proposal-toolbar[\s\S]*flex-wrap: nowrap[\s\S]*overflow: visible[\s\S]*\.obsreview-native-proposal-action[\s\S]*flex: 1 1 0/u,
  );
  assert.doesNotMatch(givenStyles, /\.obsreview-native-proposal \.view-header \{/u);
});

test("closing either native Markdown leaf releases its owned review views", async () => {
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");

  const closeCallbacks = givenPairSource.match(/\(\) => closePair\(\)/gu) ?? [];
  assert.equal(closeCallbacks.length, 2);
  assert.match(givenPairSource, /reviewLeaves\.release\(baseOwned, proposalOwned\)/u);
  assert.match(givenPairSource, /request\.onClose\(\)/u);
});

test("stale native Markdown leaves do not crash pair reuse or cleanup", async () => {
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");

  assert.match(
    givenPairSource,
    /isOpen:\s*\(\)\s*=>\s*!closed\s*&&\s*isNativeViewMounted\(baseView\.containerEl\)\s*&&\s*isNativeViewMounted\(proposalView\.containerEl\)/u,
  );
  assert.doesNotMatch(
    givenPairSource,
    /isOpen:\s*\(\)\s*=>[^\n]*(?:baseLeaf|proposalLeaf)\.view/u,
  );
  assert.match(
    givenPairSource,
    /const baseOwned = isNativeViewMounted\(baseView\.containerEl\)/u,
  );
  assert.match(
    givenPairSource,
    /const proposalOwned = isNativeViewMounted\(proposalView\.containerEl\)/u,
  );
});

test("native hunk focus replans against the live proposal", async () => {
  const givenDiffSource = await readEditorSource("native-diff-decorations.ts");

  const focusIndex = givenDiffSource.indexOf("focusHunk: (index) =>");
  const livePlanIndex = givenDiffSource.indexOf(
    "planNativeDiffBlocks(content.base, proposalView.getViewData())",
  );

  assert.notEqual(focusIndex, -1);
  assert.ok(livePlanIndex > focusIndex);
});

test("native alignment block widgets are provided by a state field", async () => {
  const givenExtensionSource = await readEditorSource("native-diff-extension.ts");

  assert.match(givenExtensionSource, /StateField\.define<DecorationSet>/u);
  assert.match(givenExtensionSource, /EditorView\.decorations\.from\(field\)/u);
  assert.doesNotMatch(
    givenExtensionSource,
    /ViewPlugin\.fromClass\([\s\S]*decorations:/u,
  );
});

async function readEditorSource(filename: string): Promise<string> {
  return readFile(
    path.join(process.cwd(), "packages", "obsidian-plugin", "src", "editor", filename),
    "utf8",
  );
}
