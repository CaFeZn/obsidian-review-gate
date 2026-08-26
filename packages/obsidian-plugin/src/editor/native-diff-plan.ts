import { JsDiffEngine } from "../../../core/src/diff/jsdiff-engine";
import type { DiffHunk, DiffLine } from "../../../core/src/diff/types";

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
