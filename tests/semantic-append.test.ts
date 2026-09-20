import test from "node:test";
import assert from "node:assert/strict";
import {
  applySemanticAppend,
  materializeSemanticAppend,
  removeSemanticAppend,
} from "../packages/core/src/patch/semantic-append";

test("semantic append targets one Markdown heading section", () => {
  const document = "# 日报\n\n## 当日进度\n\n- existing\n\n## 明日待办\n\n- next\n";
  const result = applySemanticAppend(document, {
    anchor: "## 当日进度",
    content: "- added\n",
  });

  assert.deepEqual(result, {
    ok: true,
    content: "# 日报\n\n## 当日进度\n\n- existing\n- added\n\n## 明日待办\n\n- next\n",
  });
});

test("semantic removal preserves later sibling appends", () => {
  const document = "# 日报\r\n\r\n## 当日进度\r\n\r\n- A\r\n- B\r\n";
  const result = removeSemanticAppend(document, {
    anchor: "## 当日进度",
    content: "- A\n",
  });

  assert.deepEqual(result, {
    ok: true,
    content: "# 日报\r\n\r\n## 当日进度\r\n\r\n- B\r\n",
  });
});

test("semantic removal refuses an edited fragment", () => {
  const result = materializeSemanticAppend(
    "# 日报\n\n## 当日进度\n\n- A（已补充）\n",
    {
      anchor: "## 当日进度",
      content: "- A\n",
      action: "remove",
    },
  );

  assert.deepEqual(result, { ok: false, reason: "content-not-found" });
});
