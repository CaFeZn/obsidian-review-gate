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
    "submitAcceptedBlocks",
    "approveReview",
  ]) {
    assert.match(givenPairSource, new RegExp(`t\\("${key}"\\)`, "u"));
  }
  assert.match(givenPairSource, /request\.onDecideHunk/u);
  assert.match(givenPairSource, /request\.onSubmitAccepted/u);
  assert.match(givenPairSource, /request\.onApprove/u);
  assert.match(givenPairSource, /setAttribute\("role", "toolbar"\)/u);
  assert.match(
    givenPairSource,
    /setAttribute\("aria-label", t\("editableProposal"\)\)/u,
  );
});

test("the automatic save hook debounces writes instead of persisting on every keystroke", async () => {
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");

  // Given: Obsidian calls requestSave on every document update, including each
  // intermediate state of an IME composition.
  const hookIndex = givenPairSource.indexOf("public override requestSave");
  const ctorIndex = givenPairSource.indexOf("public constructor(");
  assert.notEqual(hookIndex, -1);
  assert.notEqual(ctorIndex, -1);
  const hookBody = givenPairSource.slice(hookIndex, ctorIndex);

  // Then: the hook records the dirty state, refreshes the tab title, and defers
  // the write, so typing stays responsive and a composition cannot be lost to a
  // mid-keystroke reload.
  assert.match(hookBody, /this\.dirty = true/u);
  assert.match(hookBody, /this\.leaf\.updateHeader\(\)/u);
  // The write is scheduled on the debouncing scheduler rather than performed
  // inline, so continuous typing never writes mid-input.
  assert.match(hookBody, /const scheduler = this\.scheduler\(\)/u);
  assert.match(hookBody, /scheduler\.schedule\(\)/u);
  assert.doesNotMatch(hookBody, /await this\.onSaveRequested/u);

  // And: the deferred write still happens on its own, so an edit is never held in
  // the editor until the user presses save.
  assert.match(givenPairSource, /saveDebounceMs\s*=\s*2000/u);
  assert.match(givenPairSource, /createNativeSaveScheduler\(\{/u);
  assert.match(
    givenPairSource,
    /public override save\(\): Promise<void>[\s\S]*?scheduler\.schedule\(\)/u,
  );

  // And: the explicit path persists immediately and clears the marker.
  assert.match(givenPairSource, /public async persist\(\): Promise<void>/u);
  assert.match(givenPairSource, /await this\.onSaveRequested\(\)/u);
  assert.match(givenPairSource, /markSaved/u);
  // And: closing the pane flushes a pending edit instead of dropping it.
  assert.match(givenPairSource, /onClose[\s\S]*?this\.saveScheduler\?\.cancel\(\);\n\s*if \(this\.dirty\) await this\.persist\(\);/u);
  // The title carries the unsaved marker so a dirty draft is visible.
  assert.match(givenPairSource, /t\("proposalUnsaved"\)/u);
});

test("single-page native review uses the same deferred save and close flush", async () => {
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");

  assert.match(givenPairSource, /class ReviewUnifiedView extends ItemView/u);
  assert.match(
    givenPairSource,
    /class ReviewUnifiedView[\s\S]*?createNativeSaveScheduler\(\{/u,
  );
  assert.match(
    givenPairSource,
    /class ReviewUnifiedView[\s\S]*?this\.saveScheduler\.schedule\(\)/u,
  );
  assert.match(
    givenPairSource,
    /class ReviewUnifiedView[\s\S]*?if \(this\.dirty\) await this\.persist\(\);/u,
  );
  assert.match(
    givenPairSource,
    /addAction\("save", t\("saveProposal"\), \(\) => void this\.persist\(\)\)/u,
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
  // Both split panes forward their close, and the single-page view forwards its
  // own close as well, so every owned view releases the session exactly once.
  assert.ok(closeCallbacks.length >= 2);
  assert.match(givenPairSource, /reviewLeaves\.release\(baseOwned, proposalOwned\)/u);
  assert.match(givenPairSource, /request\.onClose\(\)/u);
});

test("single-page native review reuses the same request and releases on close", async () => {
  const givenPairSource = await readEditorSource("native-markdown-pair.ts");

  assert.match(givenPairSource, /if \(request\.mode === "unified"\)/u);
  assert.match(givenPairSource, /class ReviewUnifiedView extends ItemView/u);
  assert.match(givenPairSource, /onModeChange\?\.\("split"/u);
  assert.match(givenPairSource, /tryCreateMergeEditor/u);
  assert.match(givenPairSource, /isNativeViewMounted\(view\.containerEl\)/u);
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
  assert.match(givenDiffSource, /focusNativeHunk\(baseEditor, proposalEditor, blocks, index\)/u);
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

test("native diff pairs apply measured row alignment to hunk scroll anchors", async () => {
  const givenDiffSource = await readEditorSource("native-diff-decorations.ts");
  const givenAlignmentSource = await readEditorSource("native-visual-alignment.ts");
  const givenStyles = await readFile(
    path.join(process.cwd(), "packages", "obsidian-plugin", "styles.css"),
    "utf8",
  );

  assert.match(givenDiffSource, /bindNativeVisualAlignment/u);
  assert.match(givenDiffSource, /anchors: visualAlignmentBinding\.anchors/u);
  assert.match(givenDiffSource, /visualAlignmentBinding\.destroy\(\)/u);
  assert.match(
    givenAlignmentSource,
    /attributes: true,[\s\S]*attributeFilter: \[ALIGNMENT_KEY_ATTRIBUTE\]/u,
  );
  assert.match(
    givenStyles,
    /\[data-obsreview-align-key\]::after[\s\S]*height: var\(--obsreview-alignment-extra, 0px\)/u,
  );
  assert.doesNotMatch(
    givenStyles,
    /\.obsreview-native-spacer-line\s*\{[^}]*[\r\n]\s*height:\s*1lh/u,
  );
});

async function readEditorSource(filename: string): Promise<string> {
  return readFile(
    path.join(process.cwd(), "packages", "obsidian-plugin", "src", "editor", filename),
    "utf8",
  );
}
