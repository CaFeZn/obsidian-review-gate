import type { Range, Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import {
  findCjkWrapRanges,
  type TextRange,
} from "../text/cjk-wrap-ranges";

export function buildNativeCjkWordDecorations(
  documentValue: Text,
  excludedRanges: readonly TextRange[] = [],
): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  for (let lineNumber = 1; lineNumber <= documentValue.lines; lineNumber += 1) {
    const line = documentValue.line(lineNumber);
    const lineText = documentValue.sliceString(line.from, line.to);
    for (const range of findCjkWrapRanges(lineText)) {
      const absoluteRange = {
        from: line.from + range.from,
        to: line.from + range.to,
      };
      if (excludedRanges.some((excluded) => rangesOverlap(absoluteRange, excluded))) continue;
      addCjkWrapRange(ranges, absoluteRange.from, absoluteRange.to);
    }
  }
  return ranges;
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function addCjkWrapRange(
  ranges: Range<Decoration>[],
  from: number,
  to: number,
): void {
  ranges.push(Decoration.mark({ class: "obsreview-cm-cjk-word" }).range(from, to));
}
