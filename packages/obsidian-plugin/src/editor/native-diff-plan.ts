import { JsDiffEngine } from "../../../core/src/diff/jsdiff-engine";
import type { DiffHunk, DiffLine } from "../../../core/src/diff/types";
import { splitLinesPreserveEndings } from "../../../core/src/diff/text-lines";

export type NativeDiffSide = "base" | "proposal";

export interface NativeDiffBlock {
  readonly label: string;
  readonly baseStart: number;
  readonly proposalStart: number;
  readonly baseLines: readonly number[];
  readonly proposalLines: readonly number[];
  readonly baseSpacerLines: number;
  readonly proposalSpacerLines: number;
}

export interface NativeEqualLinePair {
  readonly baseLine: number;
  readonly proposalLine: number;
  readonly alignmentKey: string;
}

const diffEngine = new JsDiffEngine();

export function planNativeDiffBlocks(
  base: string,
  proposal: string,
): readonly NativeDiffBlock[] {
  return diffEngine.diff(base, proposal).hunks.map((hunk) => {
    const baseLines = nativeChangedLines(hunk, "base").map(
      (line) => line.oldLine ?? hunk.oldStart,
    );
    const proposalLines = nativeChangedLines(hunk, "proposal").map(
      (line) => line.newLine ?? hunk.newStart,
    );
    return {
      label: nativeHunkLabel(hunk),
      baseStart: hunk.oldStart,
      proposalStart: hunk.newStart,
      baseLines,
      proposalLines,
      baseSpacerLines: Math.max(0, proposalLines.length - baseLines.length),
      proposalSpacerLines: Math.max(0, baseLines.length - proposalLines.length),
    };
  });
}

/**
 * Pairs every unchanged line across both sides. The rendered-diff decorator uses
 * these keys to line up table rows, Callouts, and other Markdown widgets that
 * Obsidian renders as a single block.
 */
export function planNativeEqualLinePairs(
  base: string,
  proposal: string,
): readonly NativeEqualLinePair[] {
  const hunks = diffEngine.diff(base, proposal, { contextLines: 0 }).hunks;
  const pairs: NativeEqualLinePair[] = [];
  let baseLine = 1;
  let proposalLine = 1;
  const appendUntil = (baseEnd: number, proposalEnd: number): void => {
    const count = Math.min(baseEnd - baseLine, proposalEnd - proposalLine);
    for (let index = 0; index < count; index += 1) {
      const pairedBaseLine = baseLine + index;
      const pairedProposalLine = proposalLine + index;
      pairs.push({
        baseLine: pairedBaseLine,
        proposalLine: pairedProposalLine,
        alignmentKey: `equal:${pairedBaseLine}:${pairedProposalLine}`,
      });
    }
  };

  for (const hunk of hunks) {
    appendUntil(hunk.oldStart, hunk.newStart);
    baseLine = hunk.oldStart + hunk.oldLines;
    proposalLine = hunk.newStart + hunk.newLines;
  }
  appendUntil(
    splitLinesPreserveEndings(base).length + 1,
    splitLinesPreserveEndings(proposal).length + 1,
  );
  return pairs;
}

export function nativeChangedLines(
  hunk: DiffHunk,
  side: NativeDiffSide,
): readonly DiffLine[] {
  const kind = side === "base" ? "remove" : "add";
  return hunk.lines.filter((line) => line.kind === kind);
}

export function nativeHunkLabel(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}
