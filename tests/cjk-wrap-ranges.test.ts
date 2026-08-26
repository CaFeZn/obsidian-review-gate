import assert from "node:assert/strict";
import test from "node:test";
import { findCjkWrapRanges } from "../packages/obsidian-plugin/src/text/cjk-wrap-ranges";

test("CJK wrap ranges keep adjacent semantic phrases intact", () => {
  // Given: four-character terms and a connective phrase seen in the native panes.
  const phrases = ["同步滚动", "视觉门禁", "反馈循环", "和底部"];

  // When: the shared wrapping rule segments each phrase.
  const protectedPhrases = phrases.map((phrase) =>
    findCjkWrapRanges(phrase).map((range) => phrase.slice(range.from, range.to)),
  );

  // Then: every phrase is one indivisible wrap range.
  assert.deepEqual(protectedPhrases, phrases.map((phrase) => [phrase]));
});

test("CJK wrap ranges keep observed short compound phrases intact", () => {
  // Given: five- and six-character compounds that wrapped unnaturally in native panes.
  const phrases = ["中英文界面", "文件路径按钮", "中部和底部", "双视觉门禁", "插件"];

  // When: the shared wrapping rule segments each compound.
  const protectedPhrases = phrases.map((phrase) =>
    findCjkWrapRanges(phrase).map((range) => phrase.slice(range.from, range.to)),
  );

  // Then: each observed compound remains one indivisible wrap range.
  assert.deepEqual(protectedPhrases, phrases.map((phrase) => [phrase]));
});

test("CJK wrap ranges keep a single-character prefix with its following word", () => {
  // Given: the phrase that rendered as `左右高度不 / 同时` in the narrow diff pane.
  const phrase = "左右高度不同时保持相对位置一致";

  // When: the shared wrapping rule groups its semantic units.
  const protectedPhrases = findCjkWrapRanges(phrase).map((range) =>
    phrase.slice(range.from, range.to),
  );

  // Then: `不` stays with `同时` instead of ending the preceding line.
  assert.deepEqual(protectedPhrases, ["左右高度", "不同时保持", "相对位置一致"]);
});

test("CJK wrap ranges preserve short phrases inside complete sentences", () => {
  // Given: the complete sentences that exposed context-dependent greedy boundaries.
  const cases = [
    {
      text: "真实 Obsidian 中分别从左侧和右侧驱动滚动，验证另一侧跟随。",
      phrase: "驱动滚动",
    },
    {
      text: "插件已完成真实 Vault 实装和双视觉门禁。",
      phrase: "双视觉门禁",
    },
    {
      text: "视觉门禁验证反馈循环，并覆盖中部和底部。",
      phrase: "中部和底部",
    },
    {
      text: "左侧与右侧以各自可滚动范围的相对进度双向联动。",
      phrase: "可滚动范围",
    },
    {
      text: "修复中文短复合词在原生编辑器、文件路径按钮和差异内容中的不自然断行。",
      phrase: "文件路径按钮",
    },
    {
      text: "检查、完整测试、打包、制品 smoke 和行数门禁全部通过。",
      phrase: "行数门禁",
    },
  ];

  // When: each full sentence is partitioned into protected wrap ranges.
  const protectedPhrases = cases.map(({ text }) =>
    findCjkWrapRanges(text).map((range) => text.slice(range.from, range.to)),
  );

  // Then: every observed short phrase is contained by one protected range.
  assert.deepEqual(
    protectedPhrases.map((ranges, index) =>
      ranges.some((range) => range.includes(cases[index]?.phrase ?? "")),
    ),
    cases.map(() => true),
  );
});
