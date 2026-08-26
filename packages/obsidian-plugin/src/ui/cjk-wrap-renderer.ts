import { findCjkWrapRanges } from "../text/cjk-wrap-ranges";

export function renderCjkWrappedText(parent: HTMLElement, text: string): void {
  let cursor = 0;
  for (const range of findCjkWrapRanges(text)) {
    if (range.from > cursor) parent.append(text.slice(cursor, range.from));
    parent.createSpan({
      cls: "obsreview-cjk-wrap",
      text: text.slice(range.from, range.to),
    });
    cursor = range.to;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}
