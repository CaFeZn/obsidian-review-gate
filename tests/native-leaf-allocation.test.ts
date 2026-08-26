import assert from "node:assert/strict";
import test from "node:test";
import type { Workspace, WorkspaceLeaf } from "obsidian";
import { createMainWindowReviewLeaves } from "../packages/obsidian-plugin/src/editor/native-leaf-allocation";

test("native review creates a root tab then splits it into two review groups", () => {
  const calls: string[] = [];
  const baseLeaf = {} as WorkspaceLeaf;
  const proposalLeaf = {} as WorkspaceLeaf;
  const workspace = {
    iterateRootLeaves() {},
    rootSplit: {},
    getMostRecentLeaf() {
      return null;
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
  assert.equal(result.baseLeaf, baseLeaf);
  assert.equal(result.proposalLeaf, proposalLeaf);
  assert.equal(typeof result.release, "function");
});

test("native review adds tabs to two existing groups without replacing their pages", async () => {
  const root = {};
  const leftParent = {};
  const rightParent = {};
  const leftLeaf = originalLeaf(leftParent);
  const rightLeaf = originalLeaf(rightParent);
  const baseLeaf = reviewLeaf(leftParent);
  const proposalLeaf = reviewLeaf(rightParent);
  let activeLeaf: WorkspaceLeaf = leftLeaf;
  const revealed: WorkspaceLeaf[] = [];
  const workspace = {
    rootSplit: root,
    iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => void) {
      callback(leftLeaf);
      callback(rightLeaf);
    },
    getMostRecentLeaf(parent?: object) {
      if (parent === root) return leftLeaf;
      if (parent === leftParent) return leftLeaf;
      if (parent === rightParent) return rightLeaf;
      return null;
    },
    setActiveLeaf(leaf: WorkspaceLeaf) {
      activeLeaf = leaf;
    },
    getLeaf(mode: string) {
      assert.equal(mode, "tab");
      if (activeLeaf === leftLeaf) return baseLeaf;
      if (activeLeaf === rightLeaf) return proposalLeaf;
      assert.fail("review tabs must be created from an original group leaf");
    },
    createLeafBySplit() {
      assert.fail("must not split an existing two-pane layout again");
    },
    async revealLeaf(leaf: WorkspaceLeaf) {
      revealed.push(leaf);
    },
  } as unknown as Workspace;

  const result = createMainWindowReviewLeaves(workspace);
  await result.release(true, true);

  assert.equal(result.baseLeaf, baseLeaf);
  assert.equal(result.proposalLeaf, proposalLeaf);
  assert.equal(baseLeaf.parent, leftParent);
  assert.equal(proposalLeaf.parent, rightParent);
  assert.equal(Reflect.get(baseLeaf, "detached"), true);
  assert.equal(Reflect.get(proposalLeaf, "detached"), true);
  assert.deepEqual(revealed, [leftLeaf]);

  function originalLeaf(parent: object): WorkspaceLeaf {
    return {
      parent,
      open: () => assert.fail("an original page must never be replaced"),
      setViewState: () => assert.fail("an original page must never be restored in place"),
      setEphemeralState: () => assert.fail("an original page state must remain untouched"),
      detach: () => assert.fail("an original page must remain open"),
    } as unknown as WorkspaceLeaf;
  }

  function reviewLeaf(parent: object): WorkspaceLeaf {
    return {
      parent,
      detached: false,
      detach() {
        Reflect.set(this, "detached", true);
      },
    } as unknown as WorkspaceLeaf;
  }
});

test("closing newly created review leaves returns to the prior active page", async () => {
  const root = {};
  const originalParent = {};
  const originalLeaf = { parent: originalParent } as unknown as WorkspaceLeaf;
  let baseDetached = false;
  let proposalDetached = false;
  const baseLeaf = {
    detach: () => {
      baseDetached = true;
    },
  } as unknown as WorkspaceLeaf;
  const proposalLeaf = {
    detach: () => {
      proposalDetached = true;
    },
  } as unknown as WorkspaceLeaf;
  const revealed: WorkspaceLeaf[] = [];
  const workspace = {
    rootSplit: root,
    iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => void) {
      callback(originalLeaf);
    },
    getMostRecentLeaf(parent?: object) {
      return parent === root ? originalLeaf : null;
    },
    getLeaf: () => baseLeaf,
    createLeafBySplit: () => proposalLeaf,
    async revealLeaf(target: WorkspaceLeaf) {
      revealed.push(target);
    },
  } as unknown as Workspace;

  const result = createMainWindowReviewLeaves(workspace);
  await result.release(true, true);

  assert.equal(baseDetached, true);
  assert.equal(proposalDetached, true);
  assert.deepEqual(revealed, [originalLeaf]);
});
