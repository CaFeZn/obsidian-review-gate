import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { planNativeDiffBlocks } from "../packages/obsidian-plugin/src/editor/native-diff-plan";
import { buildNativeDiffDecorations } from "../packages/obsidian-plugin/src/editor/native-diff-decoration-builder";

test("native editor groups separated changes into distinct diff blocks", () => {
  // Given: two replacements separated by more than the configured hunk context.
  const unchanged = Array.from({ length: 8 }, (_, index) => `stable ${index + 1}`);
  const base = ["top", "old first", ...unchanged, "old second", "end", ""].join("\n");
  const proposal = ["top", "new first", ...unchanged, "new second", "end", ""].join("\n");

  // When: the native editor decoration plan is created.
  const blocks = planNativeDiffBlocks(base, proposal);

  // Then: each replacement remains an independently labeled and navigable block.
  assert.deepEqual(
    blocks.map((block) => ({
      label: block.label,
      baseLines: block.baseLines,
      proposalLines: block.proposalLines,
    })),
    [
      { label: "@@ -2,1 +2,1 @@", baseLines: [2], proposalLines: [2] },
      { label: "@@ -11,1 +11,1 @@", baseLines: [11], proposalLines: [11] },
    ],
  );
});

test("native editor keeps four nearby review blocks navigable", () => {
  const base = [
    "top",
    "old first",
    "stable one",
    "stable two",
    "old second",
    "stable three",
    "stable four",
    "old third",
    "stable five",
    "stable six",
    "old fourth",
    "end",
    "",
  ].join("\n");
  const proposal = [
    "top",
    "new first",
    "stable one",
    "stable two",
    "new second",
    "stable three",
    "stable four",
    "new third",
    "stable five",
    "stable six",
    "new fourth",
    "end",
    "",
  ].join("\n");

  const blocks = planNativeDiffBlocks(base, proposal);

  assert.equal(blocks.length, 4);
  assert.deepEqual(
    blocks.map((block) => block.proposalStart),
    [2, 5, 8, 11],
  );
});

test("native editor only marks the selected hunk as active", () => {
  const base = "one\nold one\nthree\nold two\nfive\n";
  const proposal = "one\nnew one\nthree\nnew two\nfive\n";
  const blocks = planNativeDiffBlocks(base, proposal);
  const documentValue = EditorState.create({ doc: proposal }).doc;

  const activeClasses = (activeHunkLabel?: string): readonly string[] => {
    const decorations = buildNativeDiffDecorations(documentValue, {
      base,
      proposal,
      side: "proposal",
      ...(activeHunkLabel === undefined ? {} : { activeHunkLabel }),
    });
    const classes: string[] = [];
    decorations.between(0, documentValue.length, (_from, _to, value) => {
      const spec: unknown = value.spec;
      if (spec === null || typeof spec !== "object") return;
      const attributes: unknown = Reflect.get(spec, "attributes");
      if (attributes === null || typeof attributes !== "object") return;
      const className = Reflect.get(attributes, "class");
      if (typeof className === "string") classes.push(className);
    });
    return classes;
  };

  assert.equal(
    activeClasses().filter((className) => className.includes("obsreview-native-hunk-active"))
      .length,
    0,
  );
  const selected = activeClasses(blocks[1]?.label);
  assert.equal(
    selected.filter((className) => className.includes("obsreview-native-hunk-active"))
      .length,
    1,
  );
});

test("native editor plans blank rows on the shorter side of unequal hunks", () => {
  const fewerBaseLines = planNativeDiffBlocks(
    "top\nold\nend\n",
    "top\nnew one\nnew two\nnew three\nend\n",
  );
  const fewerProposalLines = planNativeDiffBlocks(
    "top\nold one\nold two\nold three\nend\n",
    "top\nnew\nend\n",
  );
  const insertedLines = planNativeDiffBlocks(
    "top\nend\n",
    "top\ninserted one\ninserted two\nend\n",
  );
  const deletedLines = planNativeDiffBlocks(
    "top\ndeleted one\ndeleted two\nend\n",
    "top\nend\n",
  );

  assert.deepEqual(
    [fewerBaseLines, fewerProposalLines, insertedLines, deletedLines].map((blocks) =>
      blocks.map((block) => ({
        baseSpacerLines: Reflect.get(block, "baseSpacerLines"),
        proposalSpacerLines: Reflect.get(block, "proposalSpacerLines"),
      })),
    ),
    [
      [{ baseSpacerLines: 2, proposalSpacerLines: 0 }],
      [{ baseSpacerLines: 0, proposalSpacerLines: 2 }],
      [{ baseSpacerLines: 2, proposalSpacerLines: 0 }],
      [{ baseSpacerLines: 0, proposalSpacerLines: 2 }],
    ],
  );
});

test("native editor renders unequal-hunk alignment as block widgets", () => {
  const collectSpacers = (base: string, proposal: string): readonly unknown[] => {
    const documentValue = EditorState.create({ doc: base }).doc;
    const decorations = buildNativeDiffDecorations(documentValue, {
      base,
      proposal,
      side: "base",
    });
    const spacers: unknown[] = [];
    decorations.between(0, documentValue.length, (_from, _to, value) => {
      const spec: unknown = value.spec;
      if (spec === null || typeof spec !== "object") return;
      const spacerLines = Reflect.get(spec, "obsreviewSpacerLines");
      if (typeof spacerLines !== "number") return;
      spacers.push({
        block: Reflect.get(spec, "block"),
        label: Reflect.get(spec, "obsreviewHunkLabel"),
        spacerLines,
      });
    });
    return spacers;
  };

  assert.deepEqual(
    collectSpacers(
      "top\nold\nend\n",
      "top\nnew one\nnew two\nnew three\nend\n",
    ),
    [{ block: true, label: undefined, spacerLines: 2 }],
  );
  assert.deepEqual(
    collectSpacers(
      "top\nend\n",
      "top\ninserted one\ninserted two\nend\n",
    ),
    [{ block: true, label: "@@ -2,0 +2,2 @@", spacerLines: 2 }],
  );
});

test("native editor gives both sides matching visual alignment keys", () => {
  const base = "top\nold\nend\n";
  const proposal = "top\nnew one\nnew two\nnew three\nend\n";
  const collectAlignmentKeys = (
    documentText: string,
    side: "base" | "proposal",
  ): readonly string[] => {
    const documentValue = EditorState.create({ doc: documentText }).doc;
    const decorations = buildNativeDiffDecorations(documentValue, { base, proposal, side });
    const keys: string[] = [];
    decorations.between(0, documentValue.length, (_from, _to, value) => {
      const spec: unknown = value.spec;
      if (spec === null || typeof spec !== "object") return;
      const attributes: unknown = Reflect.get(spec, "attributes");
      if (attributes !== null && typeof attributes === "object") {
        const key = Reflect.get(attributes, "data-obsreview-align-key");
        if (typeof key === "string") keys.push(key);
      }
      const spacerKeys = Reflect.get(spec, "obsreviewAlignmentKeys");
      if (!Array.isArray(spacerKeys)) return;
      for (const key of spacerKeys) {
        if (typeof key === "string") keys.push(key);
      }
    });
    return keys;
  };

  const baseKeys = collectAlignmentKeys(base, "base");
  const proposalKeys = collectAlignmentKeys(proposal, "proposal");

  assert.equal(baseKeys.length, 5);
  assert.deepEqual(baseKeys, proposalKeys);
  assert.equal(new Set(baseKeys).size, 5);
});

test("native editor gives unchanged headings matching visual alignment keys", () => {
  const headings = ["## 目标", "## 范围", "## 验收标准", "## 20260826", "## 实现记录"];
  const base = [
    "---",
    "title: same",
    "dateModified: old",
    "---",
    headings[0],
    "old goal",
    headings[1],
    "old scope",
    headings[2],
    "old acceptance",
    headings[3],
    "old day",
    headings[4],
    "old implementation",
    "",
  ].join("\n");
  const proposal = base
    .replace("dateModified: old", "dateModified: new")
    .replace("old goal", "new goal")
    .replace("old scope", "new scope")
    .replace("old acceptance", "new acceptance")
    .replace("old day", "new day")
    .replace("old implementation", "new implementation");

  const collectHeadingKeys = (
    documentText: string,
    side: "base" | "proposal",
  ): Readonly<Record<string, string>> => {
    const documentValue = EditorState.create({ doc: documentText }).doc;
    const decorations = buildNativeDiffDecorations(documentValue, { base, proposal, side });
    const keys: Record<string, string> = {};
    decorations.between(0, documentValue.length, (from, _to, value) => {
      const spec: unknown = value.spec;
      if (spec === null || typeof spec !== "object") return;
      const attributes: unknown = Reflect.get(spec, "attributes");
      if (attributes === null || typeof attributes !== "object") return;
      const key: unknown = Reflect.get(attributes, "data-obsreview-align-key");
      const line = documentValue.lineAt(from).text;
      if (typeof key === "string" && headings.includes(line)) keys[line] = key;
    });
    return keys;
  };

  const baseKeys = collectHeadingKeys(base, "base");
  const proposalKeys = collectHeadingKeys(proposal, "proposal");

  assert.deepEqual(Object.keys(baseKeys), headings);
  assert.deepEqual(baseKeys, proposalKeys);
});

test("native editor keeps a short CJK changed phrase with its punctuation", () => {
  // Given: a short changed phrase enclosed by Chinese quotes at a narrow-wrap boundary.
  const base = "第一处旧内容：原生编辑器还没有按变更块高亮这一行，也看不出“旧内容”。\n";
  const proposal = "第一处新内容：原生编辑器应按变更块高亮这一行，并标出“新内容”。\n";
  const documentValue = EditorState.create({ doc: base }).doc;

  // When: the base-side native diff decorations are created.
  const decorations = buildNativeDiffDecorations(documentValue, {
    base,
    proposal,
    side: "base",
  });
  const wrappedText: string[] = [];
  decorations.between(0, documentValue.length, (from, to, value) => {
    const spec: unknown = value.spec;
    if (spec === null || typeof spec !== "object") return;
    if (Reflect.get(spec, "class") !== "obsreview-cm-inline-phrase") return;
    wrappedText.push(documentValue.sliceString(from, to));
  });

  // Then: line breaking treats the changed phrase and paired punctuation as one short unit.
  assert.deepEqual(wrappedText, ["也看不出", "“旧内容”。"]);
});

test("native editor keeps a short CJK phrase when its leading punctuation changes", () => {
  // Given: a four-character CJK phrase changed together with its leading punctuation.
  const base = "- 未经明确授权，不提交、不推送、不发布 Release。\n";
  const proposal = "- 未经明确授权，不提交、不推送，也不发布 Release。\n";
  const documentValue = EditorState.create({ doc: proposal }).doc;

  // When: the proposal-side native diff decorations are created.
  const decorations = buildNativeDiffDecorations(documentValue, {
    base,
    proposal,
    side: "proposal",
  });
  const wrappedText: string[] = [];
  decorations.between(0, documentValue.length, (from, to, value) => {
    const spec: unknown = value.spec;
    if (spec === null || typeof spec !== "object") return;
    if (Reflect.get(spec, "class") !== "obsreview-cm-inline-phrase") return;
    wrappedText.push(documentValue.sliceString(from, to));
  });

  // Then: the preceding clause and changed phrase form two bounded no-wrap units.
  assert.deepEqual(wrappedText, ["不推送，", "也不发布"]);
});

test("native editor keeps CJK words intact outside changed fragments", () => {
  // Given: unchanged and changed lines containing short Chinese words.
  const unchanged =
    "主视图增加插件命令并显示状态值。\n设置页不新增网络依赖或复杂运行时。\n保持英文为完整回退语言；中英文翻译键在编译期保持一致。";
  const base = `${unchanged}\n- 未经明确授权，不提交、不推送、不发布 Release。\n`;
  const proposal = `${unchanged}\n- 未经明确授权，不提交、不推送，也不发布 Release。\n`;
  const documentValue = EditorState.create({ doc: proposal }).doc;

  // When: proposal-side native diff decorations are created.
  const decorations = buildNativeDiffDecorations(documentValue, {
    base,
    proposal,
    side: "proposal",
  });
  const wrappedRanges: { readonly from: number; readonly to: number }[] = [];
  decorations.between(0, documentValue.length, (from, to, value) => {
    const spec: unknown = value.spec;
    if (spec === null || typeof spec !== "object") return;
    const className = Reflect.get(spec, "class");
    if (
      className !== "obsreview-cm-cjk-word" &&
      className !== "obsreview-cm-inline-phrase"
    ) {
      return;
    }
    wrappedRanges.push({ from, to });
  });

  // Then: every word observed split in the narrow native panes is protected.
  for (const word of [
    "增加",
    "主视图",
    "状态值",
    "插件命令",
    "语言",
    "中英文",
    "翻译键",
    "在编译期",
    "运行时",
    "一致",
    "不提交",
    "不推送",
  ]) {
    const wordStart = documentValue.toString().indexOf(word);
    assert.notEqual(wordStart, -1, `${word} must exist in the fixture`);
    assert.ok(
      wrappedRanges.some(
        (range) => range.from <= wordStart && range.to >= wordStart + word.length,
      ),
      `${word} must remain inside one wrap unit`,
    );
  }
  assert.ok(
    wrappedRanges.every((range) => range.to - range.from <= 6),
    "CJK wrap units must remain at most six characters long",
  );
});
