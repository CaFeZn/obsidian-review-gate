import assert from "node:assert/strict";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { buildSync } from "esbuild";
import type { Review } from "../packages/core/src/model/review";
import type { ReviewService } from "../packages/core/src/service/review-service";

interface TestPlugin {
  service: Pick<ReviewService, "list" | "markPotentialConflict">;
  scheduleTargetInspection(vaultPath: string): void;
  onunload(): void;
}

// 执行实际插件入口；只替换 Obsidian 宿主，保留真实事件调度代码。
const bundle = buildSync({
  entryPoints: [path.join(process.cwd(), "packages/obsidian-plugin/src/main.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
}).outputFiles[0];
assert.ok(bundle);
class HostStub {
  public app = { workspace: { getLeavesOfType: () => [] } };
}
const pluginModule = { exports: { default: HostStub } };
new Function("require", "module", "exports", bundle.text)(
  (id: string): unknown => id === "obsidian"
    ? { Plugin: HostStub, ItemView: HostStub, Modal: HostStub, MarkdownView: HostStub }
    : require(id),
  pluginModule,
  pluginModule.exports,
);
const Plugin = pluginModule.exports.default as unknown as new () => TestPlugin;

test("启动时一万个文件事件只读取一次待审核列表", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = new Plugin();
  let reads = 0;
  plugin.service = {
    list: async () => { reads++; return []; },
    markPotentialConflict: async () => { throw new Error("不应检查无关文件"); },
  };
  try {
    for (let index = 0; index < 10_000; index++) {
      plugin.scheduleTargetInspection(`notes/${index}.md`);
    }
    context.mock.timers.tick(200);
    await setImmediate();
    assert.equal(reads, 1);
  } finally {
    plugin.onunload();
  }
});

test("检查尚未完成时的新事件排入下一批且不并发读取", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = new Plugin();
  let finishFirst: (() => void) | undefined;
  const firstRead = new Promise<void>((resolve) => { finishFirst = resolve; });
  let reads = 0;
  plugin.service = {
    list: async () => { if (++reads === 1) await firstRead; return []; },
    markPotentialConflict: async () => { throw new Error("不应检查无关文件"); },
  };
  try {
    plugin.scheduleTargetInspection("first.md");
    context.mock.timers.tick(200);
    plugin.scheduleTargetInspection("second.md");
    context.mock.timers.tick(200);
    assert.equal(reads, 1);
    finishFirst?.();
    await setImmediate();
    context.mock.timers.tick(200);
    await setImmediate();
    assert.equal(reads, 2);
  } finally {
    finishFirst?.();
    plugin.onunload();
  }
});

test("卸载插件取消尚未执行的检查", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = new Plugin();
  let reads = 0;
  plugin.service = {
    list: async () => { reads++; return []; },
    markPotentialConflict: async () => { throw new Error("不应检查无关文件"); },
  };
  plugin.scheduleTargetInspection("note.md");
  plugin.onunload();
  context.mock.timers.tick(200);
  await setImmediate();
  assert.equal(reads, 0);
});

test("合并事件仍检查源路径和重命名目标且每个审核只标记一次", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = new Plugin();
  const reviews = [givenReview("source"), givenReview("destination"), givenReview("unrelated")];
  const marked: string[] = [];
  plugin.service = {
    list: async () => reviews,
    markPotentialConflict: async (id) => {
      marked.push(id);
      const review = reviews.find((item) => item.id === id);
      assert.ok(review);
      return review;
    },
  };
  try {
    plugin.scheduleTargetInspection("source/old.md");
    plugin.scheduleTargetInspection("source\\new.md");
    plugin.scheduleTargetInspection("destination\\new.md");
    plugin.scheduleTargetInspection("destination/new.md");
    context.mock.timers.tick(200);
    await setImmediate();
    assert.deepEqual(marked, ["source", "destination"]);
  } finally {
    plugin.onunload();
  }
});

test("卸载后正在读取的检查不再标记审核也不启动下一批", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = new Plugin();
  let finish: (() => void) | undefined;
  const read = new Promise<void>((resolve) => { finish = resolve; });
  let reads = 0;
  let marks = 0;
  plugin.service = {
    list: async () => { reads++; await read; return [givenReview("source")]; },
    markPotentialConflict: async () => { marks++; return givenReview("source"); },
  };
  plugin.scheduleTargetInspection("source/old.md");
  context.mock.timers.tick(200);
  plugin.scheduleTargetInspection("next.md");
  plugin.onunload();
  finish?.();
  await setImmediate();
  context.mock.timers.tick(200);
  await setImmediate();
  assert.equal(reads, 1);
  assert.equal(marks, 0);
});

test("内部审核文件事件不会触发目标检查", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const plugin = new Plugin();
  let reads = 0;
  plugin.service = {
    list: async () => { reads++; return []; },
    markPotentialConflict: async () => { throw new Error("不应检查内部文件"); },
  };
  plugin.scheduleTargetInspection(".obsreview");
  plugin.scheduleTargetInspection(".obsreview/pending/meta.rgdata");
  plugin.scheduleTargetInspection(".obsreview\\pending\\meta.rgdata");
  context.mock.timers.tick(200);
  await setImmediate();
  plugin.onunload();
  assert.equal(reads, 0);
});

function givenReview(id: string): Review {
  return {
    schemaVersion: 1,
    id,
    status: "pending",
    revision: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    changes: [{
      id: "0001",
      operation: "rename",
      target: `${id}/old.md`,
      newTarget: `${id}/new.md`,
      baseHash: null,
      baseContent: "base\n",
      proposalContent: "proposal\n",
      proposalHash: null,
      hunkDecisions: {},
    }],
  };
}
