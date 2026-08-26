import type { Workspace, WorkspaceLeaf } from "obsidian";

export interface NativeReviewLeaves {
  readonly baseLeaf: WorkspaceLeaf;
  readonly proposalLeaf: WorkspaceLeaf;
}

export function createMainWindowReviewLeaves(workspace: Workspace): NativeReviewLeaves {
  const baseLeaf = workspace.getLeaf("tab");
  const proposalLeaf = workspace.createLeafBySplit(baseLeaf, "vertical");
  return { baseLeaf, proposalLeaf };
}
