import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  classifyNativeRenderedDiffBlock,
  matchesNativeRenderedChangedText,
  nativeRenderedAlignmentKey,
  normalizeNativeRenderedText,
  planNativeRenderedChangedLines,
  planNativeRenderedDiffBlocks,
  planNativeTableMarksByTable,
  type NativeRenderedDiffBlock,
} from "../packages/obsidian-plugin/src/editor/native-rendered-diff-blocks";

const blocks: readonly NativeRenderedDiffBlock[] = [
  {
    label: "@@ -4,2 +4,4 @@",
    baseLines: [4, 5],
    proposalLines: [4, 5, 6, 7],
  },
];

test("rendered table and callout widgets inherit proposal diff state from their source line", () => {
  assert.deepEqual(classifyNativeRenderedDiffBlock(blocks, "proposal", 6), {
    kind: "add",
    label: "@@ -4,2 +4,4 @@",
  });
  assert.equal(classifyNativeRenderedDiffBlock(blocks, "proposal", 12), null);
});

test("rendered widgets on the base side use removal state", () => {
  assert.deepEqual(classifyNativeRenderedDiffBlock(blocks, "base", 5), {
    kind: "remove",
    label: "@@ -4,2 +4,4 @@",
  });
});

test("unchanged rendered widgets inherit the same cross-pane alignment key", () => {
  const pairs = [
    { baseLine: 1, proposalLine: 10, alignmentKey: "equal:1:10" },
  ];

  assert.equal(nativeRenderedAlignmentKey(pairs, "base", 1), "equal:1:10");
  assert.equal(nativeRenderedAlignmentKey(pairs, "proposal", 10), "equal:1:10");
  assert.equal(nativeRenderedAlignmentKey(pairs, "proposal", 11), null);
});

test("rendered table and callout are marked when a changed row is inside the block", () => {
  const base = [
    "# Demo",
    "",
    "| 项目 | 内容 |",
    "| --- | --- |",
    "| 状态 | open |",
    "",
    "> [!important]",
    "> 旧说明",
  ].join("\n");
  const proposal = [
    "# Demo",
    "",
    "| 项目 | 内容 |",
    "| --- | --- |",
    "| 状态 | in-progress |",
    "",
    "> [!important]",
    "> 新说明",
  ].join("\n");

  const blocks = planNativeRenderedDiffBlocks(base, proposal);

  assert.equal(classifyNativeRenderedDiffBlock(blocks, "base", 3)?.kind, "remove");
  assert.equal(classifyNativeRenderedDiffBlock(blocks, "proposal", 3)?.kind, "add");
  assert.equal(classifyNativeRenderedDiffBlock(blocks, "base", 7)?.kind, "remove");
  assert.equal(classifyNativeRenderedDiffBlock(blocks, "proposal", 7)?.kind, "add");
});

test("changed source lines expose their text for per-row matching", () => {
  const base = ["| A | B |", "| --- | --- |", "| 1 | x |", "| 2 | y |"].join("\n");
  const proposal = ["| A | B |", "| --- | --- |", "| 1 | x |", "| 22 | y |"].join("\n");

  const changed = planNativeRenderedChangedLines(base, proposal);

  assert.deepEqual(
    changed.base.map((entry) => entry.line),
    [4],
  );
  assert.deepEqual(
    changed.proposal.map((entry) => entry.line),
    [4],
  );
  assert.equal(changed.proposal[0]?.text, "| 22 | y |");
});

test("rendered row matching ignores Markdown syntax and inline formatting", () => {
  const changedTexts = ["| 22 | `CAN_H` | CAN 差分高电平 |"];

  // Then: the rendered table row matches even though the pipes and backticks
  // were consumed by Obsidian's renderer.
  assert.equal(
    matchesNativeRenderedChangedText("22 CAN_H CAN 差分高电平", changedTexts),
    true,
  );
  // And: an unchanged sibling row stays unmarked.
  assert.equal(
    matchesNativeRenderedChangedText("3 CAN_L CAN 差分低电平", changedTexts),
    false,
  );
});

test("Callout paragraphs match their quoted source lines", () => {
  const changedTexts = ["> 精度目标：80A 内电流准确度 0.2A，电压准确度 0.15V。"];

  assert.equal(
    matchesNativeRenderedChangedText(
      "精度目标：80A 内电流准确度 0.2A，电压准确度 0.15V。",
      changedTexts,
    ),
    true,
  );
  assert.equal(
    matchesNativeRenderedChangedText("其它说明文字", changedTexts),
    false,
  );
});

test("rendered text normalization drops blockquote and list markers", () => {
  assert.equal(normalizeNativeRenderedText("> - 列表项甲"), "列表项甲");
  assert.equal(normalizeNativeRenderedText("| 22 | CAN_H |"), "22canh");
});

test("a reformatted table marks only the cells whose text changed", () => {
  // Given: the same table reflowed so every source line differs, while only the
  // third column of the second row actually changed content.
  const base = [
    "| 项 | 内容 |",
    "| --- | --- |",
    "| 输入范围 | 6~62 V | 需按更严格上限执行 |",
    "| 最大电流 | 110 A | 未拆分测量上限 |",
    "",
  ].join("\n");
  const proposal = [
    "| 项       | 内容     | 备注                 |",
    "| -------- | -------- | -------------------- |",
    "| 输入范围 | 6~62 V   | 已超出 62 V 上限执行 |",
    "| 最大电流 | 110 A    | 未拆分测量上限       |",
    "",
  ].join("\n");

  // When: the rendered tables are compared cell by cell.
  const marks = planNativeTableMarksByTable(base, proposal);

  // Then: only the changed cells are marked; the reflowed but identical cells
  // are not, on either side.
  const expected = [
    // The header's third column was renamed from 内容 to 备注.
    [false, false, true],
    [false, false, true],
    [false, false, false],
  ];
  assert.deepEqual(marks.proposal.get(0)?.cells, expected);
  assert.deepEqual(marks.base.get(0)?.cells, expected);
});

test("a wholly new table row is marked across its cells", () => {
  // Given: the proposal adds a row that the base does not have.
  const base = ["| 项 | 值 |", "| --- | --- |", "| 甲 | 1 |", ""].join("\n");
  const proposal = [
    "| 项 | 值 |",
    "| --- | --- |",
    "| 甲 | 1 |",
    "| 乙 | 2 |",
    "",
  ].join("\n");

  // When: the tables are compared cell by cell.
  const marks = planNativeTableMarksByTable(base, proposal);

  // Then: only the added row is marked on the proposal side, and the base side
  // holds no mark at all.
  assert.deepEqual(marks.proposal.get(0)?.cells, [
    [false, false],
    [false, false],
    [true, true],
  ]);
  assert.deepEqual(marks.base.get(0)?.cells, [
    [false, false],
    [false, false],
  ]);
});

test("aligned table columns with short delimiters still expand to the whole block", () => {
  // Given: an Obsidian-style aligned table whose delimiter row uses `--:` and
  // one-hyphen cells, as produced by the vault's own formatter.
  const base = [
    "| Pin | 信号 |",
    "| --: | ------- |",
    "|   1 | `+5V_A` |",
    "|   2 | `+5V_B` |",
    "|   3 | `CAN_H` |",
    "",
  ].join("\n");
  const proposal = base.replace("|   2 | `+5V_B` |", "| 22 | `+5V_B` |");

  // When: rendered blocks are planned for the table.
  const blocks = planNativeRenderedDiffBlocks(base, proposal);

  // Then: the changed row marks the rendered widget from its header line, not
  // only from the changed row itself.
  assert.equal(classifyNativeRenderedDiffBlock(blocks, "proposal", 1)?.kind, "add");
  assert.equal(classifyNativeRenderedDiffBlock(blocks, "proposal", 4)?.kind, "add");
  assert.deepEqual(blocks[0]?.proposalLines, [1, 2, 3, 4, 5]);
});

test("the rendered diff decorator schedules refreshes without animation frames", async () => {
  // Given: the decorator runs while a review pane may be backgrounded, where
  // animation frames are throttled and a pending refresh would never run.
  const source = await readFile(
    path.join(
      process.cwd(),
      "packages",
      "obsidian-plugin",
      "src",
      "editor",
      "native-rendered-diff-blocks.ts",
    ),
    "utf8",
  );

  // Then: refreshes are scheduled on a timer, not on requestAnimationFrame, and
  // cancellation matches the scheduler.
  assert.match(source, /frame = setTimeout\(/u);
  // No call site may schedule through an animation frame.
  assert.doesNotMatch(source, /(?:window\.)?requestAnimationFrame\s*\(/u);
  assert.match(source, /clearTimeout\(frame\)/u);
});

test("a rendered table is resolved by containment, not by its exact start line", async () => {
  const source = await readFile(
    path.join(
      process.cwd(),
      "packages",
      "obsidian-plugin",
      "src",
      "editor",
      "native-rendered-diff-blocks.ts",
    ),
    "utf8",
  );

  // Then: the widget line is matched against the table's line span, because a
  // rendered table widget does not always report the table's first row.
  assert.match(source, /line >= table\.startLine && line <= table\.endLine/u);
});
