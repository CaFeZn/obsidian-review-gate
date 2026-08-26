import type { Workspace, WorkspaceLeaf, WorkspaceParent } from "obsidian";

export interface NativeReviewLeaves {
  readonly baseLeaf: WorkspaceLeaf;
  readonly proposalLeaf: WorkspaceLeaf;
  release(baseOwned: boolean, proposalOwned: boolean): Promise<void>;
}

export function createMainWindowReviewLeaves(workspace: Workspace): NativeReviewLeaves {
  const previousActiveLeaf = workspace.getMostRecentLeaf(workspace.rootSplit);
  const existing = findTwoRootGroups(workspace);
  if (existing !== null) {
    workspace.setActiveLeaf(existing.baseLeaf, { focus: false });
    const baseLeaf = workspace.getLeaf("tab");
    workspace.setActiveLeaf(existing.proposalLeaf, { focus: false });
    const proposalLeaf = workspace.getLeaf("tab");
    if (previousActiveLeaf !== null) {
      workspace.setActiveLeaf(previousActiveLeaf, { focus: false });
    }
    return ownedReviewLeaves(workspace, baseLeaf, proposalLeaf, previousActiveLeaf);
  }
  const baseLeaf = workspace.getLeaf("tab");
  const proposalLeaf = workspace.createLeafBySplit(baseLeaf, "vertical");
  return ownedReviewLeaves(workspace, baseLeaf, proposalLeaf, previousActiveLeaf);
}

type ReviewLeafPair = Pick<NativeReviewLeaves, "baseLeaf" | "proposalLeaf">;

function findTwoRootGroups(workspace: Workspace): ReviewLeafPair | null {
  const parents: WorkspaceParent[] = [];
  const seen = new Set<WorkspaceParent>();
  workspace.iterateRootLeaves((leaf) => {
    if (seen.has(leaf.parent)) return;
    seen.add(leaf.parent);
    parents.push(leaf.parent);
  });
  if (parents.length !== 2) return null;
  const baseLeaf = workspace.getMostRecentLeaf(parents[0]);
  const proposalLeaf = workspace.getMostRecentLeaf(parents[1]);
  return baseLeaf === null || proposalLeaf === null
    ? null
    : { baseLeaf, proposalLeaf };
}

function ownedReviewLeaves(
  workspace: Workspace,
  baseLeaf: WorkspaceLeaf,
  proposalLeaf: WorkspaceLeaf,
  previousActiveLeaf: WorkspaceLeaf | null,
): NativeReviewLeaves {
  return {
    baseLeaf,
    proposalLeaf,
    release: async (baseOwned, proposalOwned) => {
      if (proposalOwned) proposalLeaf.detach();
      if (baseOwned) baseLeaf.detach();
      if (previousActiveLeaf !== null) await workspace.revealLeaf(previousActiveLeaf);
    },
  };
}
