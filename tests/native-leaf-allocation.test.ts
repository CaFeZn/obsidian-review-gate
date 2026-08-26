import assert from "node:assert/strict";
import test from "node:test";
import type { Workspace, WorkspaceLeaf } from "obsidian";
import { createMainWindowReviewLeaves } from "../packages/obsidian-plugin/src/editor/native-leaf-allocation";

test("native review creates a root tab then splits it into two review groups", () => {
  const calls: string[] = [];
  const baseLeaf = {} as WorkspaceLeaf;
  const proposalLeaf = {} as WorkspaceLeaf;
  const workspace = {
    getMostRecentLeaf() {
      assert.fail("recent-leaf lookup can select a popout window");
    },
    getLeaf(mode: string) {
      assert.equal(mode, "tab");
      calls.push("create-base-tab-in-root");
      return baseLeaf;
    },
    createLeafBySplit(leaf: WorkspaceLeaf, direction: string) {
      assert.equal(leaf, baseLeaf);
      assert.equal(direction, "vertical");
      calls.push("split-proposal-leaf-from-base");
      return proposalLeaf;
    },
  } as unknown as Workspace;

  const result = createMainWindowReviewLeaves(workspace);

  assert.deepEqual(calls, ["create-base-tab-in-root", "split-proposal-leaf-from-base"]);
  assert.deepEqual(result, { baseLeaf, proposalLeaf });
});
