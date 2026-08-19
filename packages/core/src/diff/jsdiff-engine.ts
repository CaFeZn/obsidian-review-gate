import { sha256 } from "../model/hash";
import { ReviewError } from "../model/errors";
import { myersDiff, type MyersComponent } from "../vendor/jsdiff/myers";
import { diffInline } from "./inline";
import { splitLinesPreserveEndings, stripLineEnding } from "./text-lines";
import type {
  DiffEngine,
  DiffHunk,
  DiffLine,
  DiffOptions,
  DiffResult,
} from "./types";

interface EditBlock {
  readonly baseStart: number;
  readonly baseCount: number;
  readonly proposalStart: number;
  readonly proposalCount: number;
}

interface HunkRange extends EditBlock {
  readonly displayBaseStart: number;
  readonly displayBaseEnd: number;
  readonly displayProposalStart: number;
  readonly displayProposalEnd: number;
}

export class JsDiffEngine implements DiffEngine {
  public diff(base: string, proposal: string, options: DiffOptions = {}): DiffResult {
    const baseLines = splitLinesPreserveEndings(base);
    const proposalLines = splitLinesPreserveEndings(proposal);
    const myersOptions: { timeoutMs: number; maxEditLength?: number } = {
      timeoutMs: options.timeoutMs ?? 2_000,
    };
    if (options.maxEditLength !== undefined) {
      myersOptions.maxEditLength = options.maxEditLength;
    }
    const components = myersDiff(baseLines, proposalLines, myersOptions);
    if (components === undefined) {
      throw new ReviewError(
        "INTERNAL_ERROR",
        "Diff computation exceeded its configured safety limit.",
        {
          baseLines: baseLines.length,
          proposalLines: proposalLines.length,
        },
      );
    }

    const blocks = collectEditBlocks(components);
    const contextLines = Math.max(0, options.contextLines ?? 3);
    const ranges = mergeBlocks(blocks, baseLines.length, proposalLines.length, contextLines);
    const hunks = ranges.map((range) =>
      createHunk(baseLines, proposalLines, range),
    );

    let addedLines = 0;
    let removedLines = 0;
    for (const component of components) {
      if (component.added) addedLines += component.values.length;
      if (component.removed) removedLines += component.values.length;
    }

    return {
      baseHash: sha256(base),
      proposalHash: sha256(proposal),
      hunks,
      stats: {
        addedLines,
        removedLines,
        hunkCount: hunks.length,
      },
    };
  }
}

function collectEditBlocks(
  components: readonly MyersComponent<string>[],
): readonly EditBlock[] {
  const blocks: EditBlock[] = [];
  let basePosition = 0;
  let proposalPosition = 0;
  let active:
    | {
        baseStart: number;
        proposalStart: number;
        baseCount: number;
        proposalCount: number;
      }
    | undefined;

  const flush = (): void => {
    if (active === undefined) return;
    blocks.push({ ...active });
    active = undefined;
  };

  for (const component of components) {
    if (!component.added && !component.removed) {
      flush();
      basePosition += component.values.length;
      proposalPosition += component.values.length;
      continue;
    }
    active ??= {
      baseStart: basePosition,
      proposalStart: proposalPosition,
      baseCount: 0,
      proposalCount: 0,
    };
    if (component.removed) {
      active.baseCount += component.values.length;
      basePosition += component.values.length;
    } else {
      active.proposalCount += component.values.length;
      proposalPosition += component.values.length;
    }
  }
  flush();
  return blocks;
}

function mergeBlocks(
  blocks: readonly EditBlock[],
  baseLength: number,
  proposalLength: number,
  context: number,
): readonly HunkRange[] {
  if (blocks.length === 0) return [];
  const ranges: HunkRange[] = [];
  let first = blocks[0];
  if (first === undefined) return [];
  let baseStart = first.baseStart;
  let baseEnd = first.baseStart + first.baseCount;
  let proposalStart = first.proposalStart;
  let proposalEnd = first.proposalStart + first.proposalCount;

  const flush = (): void => {
    ranges.push({
      baseStart,
      baseCount: baseEnd - baseStart,
      proposalStart,
      proposalCount: proposalEnd - proposalStart,
      displayBaseStart: Math.max(0, baseStart - context),
      displayBaseEnd: Math.min(baseLength, baseEnd + context),
      displayProposalStart: Math.max(0, proposalStart - context),
      displayProposalEnd: Math.min(proposalLength, proposalEnd + context),
    });
  };

  for (let index = 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    const baseGap = block.baseStart - baseEnd;
    const proposalGap = block.proposalStart - proposalEnd;
    if (baseGap <= context * 2 && proposalGap <= context * 2) {
      baseEnd = block.baseStart + block.baseCount;
      proposalEnd = block.proposalStart + block.proposalCount;
      continue;
    }
    flush();
    baseStart = block.baseStart;
    baseEnd = block.baseStart + block.baseCount;
    proposalStart = block.proposalStart;
    proposalEnd = block.proposalStart + block.proposalCount;
  }
  flush();
  return ranges;
}

function createHunk(
  baseLines: readonly string[],
  proposalLines: readonly string[],
  range: HunkRange,
): DiffHunk {
  const baseSegment = baseLines
    .slice(range.baseStart, range.baseStart + range.baseCount)
    .join("");
  const proposalSegment = proposalLines
    .slice(range.proposalStart, range.proposalStart + range.proposalCount)
    .join("");
  const id = sha256(
    JSON.stringify({
      baseStart: range.baseStart,
      baseCount: range.baseCount,
      proposalStart: range.proposalStart,
      proposalCount: range.proposalCount,
      baseSegment,
      proposalSegment,
    }),
  ).slice(0, 20);

  const displayBase = baseLines.slice(range.displayBaseStart, range.displayBaseEnd);
  const displayProposal = proposalLines.slice(
    range.displayProposalStart,
    range.displayProposalEnd,
  );
  const displayComponents =
    myersDiff(displayBase, displayProposal, { timeoutMs: 500 }) ?? [];
  const lines = renderLines(
    displayComponents,
    range.displayBaseStart,
    range.displayProposalStart,
  );

  return {
    id,
    oldStart: range.baseStart + 1,
    oldLines: range.baseCount,
    newStart: range.proposalStart + 1,
    newLines: range.proposalCount,
    baseStartIndex: range.baseStart,
    baseLineCount: range.baseCount,
    proposalStartIndex: range.proposalStart,
    proposalLineCount: range.proposalCount,
    baseSegment,
    proposalSegment,
    lines,
  };
}

function renderLines(
  components: readonly MyersComponent<string>[],
  initialBasePosition: number,
  initialProposalPosition: number,
): readonly DiffLine[] {
  const lines: DiffLine[] = [];
  let basePosition = initialBasePosition;
  let proposalPosition = initialProposalPosition;

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (component === undefined) continue;

    if (component.removed) {
      const next = components[index + 1];
      const additions = next?.added === true ? next.values : [];
      for (let lineIndex = 0; lineIndex < component.values.length; lineIndex += 1) {
        const raw = component.values[lineIndex] ?? "";
        const paired = additions[lineIndex];
        const value: {
          kind: "remove";
          content: string;
          oldLine: number;
          newLine: null;
          oldInline?: ReturnType<typeof diffInline>["oldFragments"];
        } = {
          kind: "remove",
          content: raw,
          oldLine: basePosition + 1,
          newLine: null,
        };
        if (paired !== undefined) {
          value.oldInline = diffInline(
            stripLineEnding(raw),
            stripLineEnding(paired),
          ).oldFragments;
        }
        lines.push(value);
        basePosition += 1;
      }
      continue;
    }

    if (component.added) {
      const previous = components[index - 1];
      const removals = previous?.removed === true ? previous.values : [];
      for (let lineIndex = 0; lineIndex < component.values.length; lineIndex += 1) {
        const raw = component.values[lineIndex] ?? "";
        const paired = removals[lineIndex];
        const value: {
          kind: "add";
          content: string;
          oldLine: null;
          newLine: number;
          newInline?: ReturnType<typeof diffInline>["newFragments"];
        } = {
          kind: "add",
          content: raw,
          oldLine: null,
          newLine: proposalPosition + 1,
        };
        if (paired !== undefined) {
          value.newInline = diffInline(
            stripLineEnding(paired),
            stripLineEnding(raw),
          ).newFragments;
        }
        lines.push(value);
        proposalPosition += 1;
      }
      continue;
    }

    for (const raw of component.values) {
      lines.push({
        kind: "context",
        content: raw,
        oldLine: basePosition + 1,
        newLine: proposalPosition + 1,
      });
      basePosition += 1;
      proposalPosition += 1;
    }
  }
  return lines;
}
