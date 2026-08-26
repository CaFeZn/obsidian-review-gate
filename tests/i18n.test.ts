import assert from "node:assert/strict";
import test from "node:test";
import { ReviewError } from "../packages/core/src/model/errors";
import {
  createTranslator,
  formatUiError,
  resolveLocale,
} from "../packages/obsidian-plugin/src/i18n/core";

test("locale resolves to Chinese when Obsidian language starts with zh", () => {
  // Given: Obsidian locale identifiers for Chinese variants.
  const locales = ["zh", "zh-CN", "zh-TW", "ZH-Hans"];

  // When: each identifier crosses the locale boundary.
  const resolved = locales.map((locale) => resolveLocale(locale));

  // Then: every Chinese variant uses the Chinese catalog.
  assert.deepEqual(resolved, ["zh", "zh", "zh", "zh"]);
});

test("locale falls back to English when Obsidian language is not Chinese", () => {
  // Given: English and unsupported locale identifiers.
  const locales = ["en", "en-US", "ja", ""];

  // When: each identifier crosses the locale boundary.
  const resolved = locales.map((locale) => resolveLocale(locale));

  // Then: every non-Chinese locale uses the English catalog.
  assert.deepEqual(resolved, ["en", "en", "en", "en"]);
});

test("locale uses the next available language signal when the Obsidian API is absent", () => {
  // Given: an older Obsidian runtime without getLanguage and a Chinese document locale.
  const apiLanguage = undefined;
  const documentLanguage = "zh";

  // When: locale candidates are resolved in priority order.
  const resolved = resolveLocale(apiLanguage, documentLanguage);

  // Then: the document locale selects the Chinese catalog.
  assert.equal(resolved, "zh");
});

test("translator returns localized text and interpolates runtime values", () => {
  // Given: translators for the two supported catalogs.
  const english = createTranslator("en");
  const chinese = createTranslator("zh");

  // When: static and parameterized messages are requested.
  const englishTitle = english("reviewGate");
  const chineseTitle = chinese("reviewGate");
  const englishRecovery = english("recoveredTransactions", { count: 2 });
  const chineseRecovery = chinese("recoveredTransactions", { count: 2 });

  // Then: each catalog supplies its own text and preserves the runtime count.
  assert.equal(englishTitle, "Review Gate");
  assert.equal(chineseTitle, "审阅门禁");
  assert.equal(englishRecovery, "Review Gate recovered 2 interrupted transaction(s).");
  assert.equal(chineseRecovery, "审阅门禁已恢复 2 个中断的事务。");
});

test("catalogs localize commands, shared actions, and file count variants", () => {
  // Given: translators for English and Chinese UI surfaces.
  const english = createTranslator("en");
  const chinese = createTranslator("zh");

  // When: command, shared action, and count-specific messages are requested.
  const messages = [
    english("openReviewGate"),
    chinese("openReviewGate"),
    english("cancel"),
    chinese("cancel"),
    english("oneFile", { count: 1 }),
    english("manyFiles", { count: 3 }),
    chinese("manyFiles", { count: 3 }),
  ];

  // Then: visible text is localized and English count grammar is explicit.
  assert.deepEqual(messages, [
    "Open Review Gate",
    "打开审阅门禁",
    "Cancel",
    "取消",
    "1 file",
    "3 files",
    "3 个文件",
  ]);
});

test("Chinese UI errors use stable ReviewError codes instead of English protocol messages", () => {
  // Given: an English protocol error raised while Obsidian is using Chinese.
  const error = new ReviewError(
    "REVISION_CONFLICT",
    "Expected revision 1 but found revision 2.",
  );

  // When: the plugin formats the error for each supported locale.
  const chinese = formatUiError("zh", error);
  const english = formatUiError("en", error);

  // Then: Chinese receives a localized summary while English keeps diagnostic detail.
  assert.equal(chinese, "审阅版本已更新，请刷新后重试。");
  assert.equal(english, "Expected revision 1 but found revision 2.");
});
