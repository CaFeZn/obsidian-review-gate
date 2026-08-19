/*
 * Adapted from jsdiff 9.0.0 src/diff/base.ts (BSD-3-Clause).
 * The adaptation keeps the mature Myers edit-graph algorithm while narrowing
 * the API to the immutable token sequences needed by Obsidian Review Gate.
 * See THIRD_PARTY_NOTICES.md and the adjacent LICENSE file.
 */

export interface MyersComponent<T> {
  readonly added: boolean;
  readonly removed: boolean;
  readonly values: readonly T[];
}

export interface MyersOptions<T> {
  readonly equals?: (left: T, right: T) => boolean;
  readonly timeoutMs?: number;
  readonly maxEditLength?: number;
}

interface DraftComponent {
  readonly added: boolean;
  readonly removed: boolean;
  readonly count: number;
  readonly previous?: DraftComponent;
}

interface Path {
  readonly oldPos: number;
  readonly last?: DraftComponent;
}

export function myersDiff<T>(
  oldTokens: readonly T[],
  newTokens: readonly T[],
  options: MyersOptions<T> = {},
): readonly MyersComponent<T>[] | undefined {
  const equals = options.equals ?? ((left: T, right: T): boolean => Object.is(left, right));
  const oldLength = oldTokens.length;
  const newLength = newTokens.length;
  const maximum = Math.min(
    oldLength + newLength,
    options.maxEditLength ?? oldLength + newLength,
  );
  const deadline = Date.now() + (options.timeoutMs ?? Number.POSITIVE_INFINITY);

  const bestPath: Array<Path | undefined> = [];
  bestPath[0] = { oldPos: -1 };

  let initial = extractCommon(bestPath[0], 0);
  if (initial.path.oldPos + 1 >= oldLength && initial.newPos + 1 >= newLength) {
    return buildValues(initial.path.last);
  }
  bestPath[0] = initial.path;

  let minDiagonal = Number.NEGATIVE_INFINITY;
  let maxDiagonal = Number.POSITIVE_INFINITY;

  for (let editLength = 1; editLength <= maximum && Date.now() <= deadline; editLength += 1) {
    for (
      let diagonal = Math.max(minDiagonal, -editLength);
      diagonal <= Math.min(maxDiagonal, editLength);
      diagonal += 2
    ) {
      const removePath = bestPath[diagonal - 1];
      const addPath = bestPath[diagonal + 1];
      bestPath[diagonal - 1] = undefined;

      let canAdd = false;
      if (addPath !== undefined) {
        const addPathNewPos = addPath.oldPos - diagonal;
        canAdd = addPathNewPos >= 0 && addPathNewPos < newLength;
      }
      const canRemove =
        removePath !== undefined && removePath.oldPos + 1 < oldLength;

      if (!canAdd && !canRemove) {
        bestPath[diagonal] = undefined;
        continue;
      }

      let basePath: Path;
      if (
        !canRemove ||
        (canAdd &&
          removePath !== undefined &&
          addPath !== undefined &&
          removePath.oldPos < addPath.oldPos)
      ) {
        if (addPath === undefined) continue;
        basePath = addToPath(addPath, true, false, 0);
      } else {
        if (removePath === undefined) continue;
        basePath = addToPath(removePath, false, true, 1);
      }

      const extracted = extractCommon(basePath, diagonal);
      basePath = extracted.path;

      if (
        basePath.oldPos + 1 >= oldLength &&
        extracted.newPos + 1 >= newLength
      ) {
        return buildValues(basePath.last);
      }

      bestPath[diagonal] = basePath;
      if (basePath.oldPos + 1 >= oldLength) {
        maxDiagonal = Math.min(maxDiagonal, diagonal - 1);
      }
      if (extracted.newPos + 1 >= newLength) {
        minDiagonal = Math.max(minDiagonal, diagonal + 1);
      }
    }
  }

  return undefined;

  function extractCommon(path: Path, diagonal: number): { path: Path; newPos: number } {
    let oldPos = path.oldPos;
    let newPos = oldPos - diagonal;
    let commonCount = 0;

    while (
      newPos + 1 < newLength &&
      oldPos + 1 < oldLength &&
      equals(oldTokens[oldPos + 1] as T, newTokens[newPos + 1] as T)
    ) {
      oldPos += 1;
      newPos += 1;
      commonCount += 1;
    }

    let last = path.last;
    if (commonCount > 0) {
      last = addComponent(last, false, false, commonCount);
    }
    const next: Path = last === undefined ? { oldPos } : { oldPos, last };
    return { path: next, newPos };
  }

  function buildValues(last: DraftComponent | undefined): readonly MyersComponent<T>[] {
    const drafts: DraftComponent[] = [];
    let current = last;
    while (current !== undefined) {
      drafts.push(current);
      current = current.previous;
    }
    drafts.reverse();

    let oldPos = 0;
    let newPos = 0;
    const result: MyersComponent<T>[] = [];
    for (const draft of drafts) {
      if (draft.removed) {
        result.push({
          added: false,
          removed: true,
          values: oldTokens.slice(oldPos, oldPos + draft.count),
        });
        oldPos += draft.count;
      } else {
        result.push({
          added: draft.added,
          removed: false,
          values: newTokens.slice(newPos, newPos + draft.count),
        });
        newPos += draft.count;
        if (!draft.added) oldPos += draft.count;
      }
    }
    return result;
  }
}

function addToPath(
  path: Path,
  added: boolean,
  removed: boolean,
  oldPosIncrement: number,
): Path {
  const last = addComponent(path.last, added, removed, 1);
  return { oldPos: path.oldPos + oldPosIncrement, last };
}

function addComponent(
  previous: DraftComponent | undefined,
  added: boolean,
  removed: boolean,
  count: number,
): DraftComponent {
  if (
    previous !== undefined &&
    previous.added === added &&
    previous.removed === removed
  ) {
    const nextPrevious = previous.previous;
    const merged: DraftComponent = {
      added,
      removed,
      count: previous.count + count,
    };
    return nextPrevious === undefined
      ? merged
      : { ...merged, previous: nextPrevious };
  }
  const component: DraftComponent = { added, removed, count };
  return previous === undefined ? component : { ...component, previous };
}
