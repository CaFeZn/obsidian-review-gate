import {
  isTerminalStatus,
  type Review,
  type ReviewChange,
} from "../../../core/src/model/review";

export interface FileHistoryEntry {
  readonly review: Review;
  readonly change: ReviewChange;
}

export interface FileHistoryIndex {
  readonly paths: readonly string[];
  entriesFor(path: string): readonly FileHistoryEntry[];
}

export function buildFileHistory(reviews: readonly Review[]): FileHistoryIndex {
  const terminalReviews = reviews.filter((review) => isTerminalStatus(review.status));
  const parents = new Map<string, string>();

  for (const review of terminalReviews) {
    for (const change of review.changes) {
      addPath(parents, change.target);
      if (change.newTarget !== undefined) addPath(parents, change.newTarget);
      if (
        review.status === "approved" &&
        change.operation === "rename" &&
        change.newTarget !== undefined
      ) {
        joinPaths(parents, change.target, change.newTarget);
      }
    }
  }

  const entries = new Map<string, FileHistoryEntry[]>();
  for (const review of terminalReviews) {
    const changeByRoot = new Map<string, ReviewChange>();
    for (const change of review.changes) {
      for (const path of [change.target, change.newTarget]) {
        if (path === undefined) continue;
        const root = findRoot(parents, normalizePath(path));
        if (!changeByRoot.has(root)) changeByRoot.set(root, change);
      }
    }
    for (const [root, change] of changeByRoot) {
      const group = entries.get(root) ?? [];
      group.push({ review, change });
      entries.set(root, group);
    }
  }

  for (const group of entries.values()) group.sort(compareEntries);
  const paths = [...parents.keys()].sort(comparePaths);

  return {
    paths,
    entriesFor(path: string): readonly FileHistoryEntry[] {
      const normalized = normalizePath(path);
      if (!parents.has(normalized)) return [];
      return entries.get(findRoot(parents, normalized)) ?? [];
    },
  };
}

export function filterFileHistoryPaths(
  paths: readonly string[],
  query: string,
): readonly string[] {
  const normalizedQuery = query.trim().toLowerCase();
  return paths
    .filter((path) => path.toLowerCase().includes(normalizedQuery))
    .sort(comparePaths);
}

function addPath(parents: Map<string, string>, path: string): string {
  const normalized = normalizePath(path);
  if (!parents.has(normalized)) parents.set(normalized, normalized);
  return normalized;
}

function joinPaths(parents: Map<string, string>, left: string, right: string): void {
  const leftRoot = findRoot(parents, addPath(parents, left));
  const rightRoot = findRoot(parents, addPath(parents, right));
  if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
}

function findRoot(parents: Map<string, string>, path: string): string {
  const parent = parents.get(path);
  if (parent === undefined) return path;
  if (parent === path) return path;
  const root = findRoot(parents, parent);
  parents.set(path, root);
  return root;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function compareEntries(left: FileHistoryEntry, right: FileHistoryEntry): number {
  const updated = comparePaths(right.review.updatedAt, left.review.updatedAt);
  return updated === 0 ? comparePaths(right.review.id, left.review.id) : updated;
}

function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
