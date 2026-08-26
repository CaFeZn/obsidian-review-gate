import type {
  DiffHunk,
  DiffLine,
  InlineFragment,
} from "../../../core/src/diff/types";
import { stripLineEnding } from "../../../core/src/diff/text-lines";
import { t } from "../i18n";
import {
  findCjkWrapRanges,
  type TextRange,
} from "../text/cjk-wrap-ranges";
import { renderCjkWrappedText } from "./cjk-wrap-renderer";

export type DiffMode = "unified" | "split";

export interface HunkCallbacks {
  readonly onAccept?: (hunk: DiffHunk) => void | Promise<void>;
  readonly onReject?: (hunk: DiffHunk) => void | Promise<void>;
  readonly decision?: "accepted" | "rejected";
  readonly readOnly?: boolean;
}

export interface RenderHunkRequest {
  readonly parent: HTMLElement;
  readonly hunk: DiffHunk;
  readonly mode: DiffMode;
  readonly callbacks: HunkCallbacks;
}

interface HunkButtonRequest {
  readonly parent: HTMLElement;
  readonly label: string;
  readonly className: string;
  readonly action: () => void | Promise<void> | undefined;
}

export function renderHunk(request: RenderHunkRequest): HTMLElement {
  const section = request.parent.createDiv({ cls: "obsreview-hunk" });
  section.id = `obsreview-hunk-${request.hunk.id}`;
  const header = section.createDiv({ cls: "obsreview-hunk-header" });
  header.createEl("code", {
    text: `@@ -${request.hunk.oldStart},${request.hunk.oldLines} +${request.hunk.newStart},${request.hunk.newLines} @@`,
  });
  if (request.callbacks.decision !== undefined) {
    header.createSpan({
      cls: `obsreview-hunk-decision is-${request.callbacks.decision}`,
      text:
        request.callbacks.decision === "accepted"
          ? t("decisionAccepted")
          : t("decisionRejected"),
    });
  }
  if (
    request.callbacks.readOnly !== true &&
    request.callbacks.onAccept !== undefined &&
    request.callbacks.onReject !== undefined
  ) {
    const actions = header.createDiv({ cls: "obsreview-hunk-actions" });
    addButton({
      parent: actions,
      label: t("acceptHunk"),
      className: "obsreview-accept",
      action: () => request.callbacks.onAccept?.(request.hunk),
    });
    addButton({
      parent: actions,
      label: t("rejectHunk"),
      className: "obsreview-reject",
      action: () => request.callbacks.onReject?.(request.hunk),
    });
  }

  if (request.mode === "split") renderSplit(section, request.hunk.lines);
  else renderUnified(section, request.hunk.lines);
  return section;
}

function renderUnified(parent: HTMLElement, lines: readonly DiffLine[]): void {
  const table = parent.createDiv({ cls: "obsreview-diff obsreview-diff-unified" });
  for (const line of lines) {
    const row = table.createDiv({ cls: `obsreview-diff-line is-${line.kind}` });
    row.createSpan({ cls: "obsreview-line-number", text: line.oldLine?.toString() ?? "" });
    row.createSpan({ cls: "obsreview-line-number", text: line.newLine?.toString() ?? "" });
    row.createSpan({
      cls: "obsreview-diff-sign",
      text: line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ",
    });
    const content = row.createSpan({ cls: "obsreview-line-content" });
    renderLineContent(content, line);
  }
}

function renderSplit(parent: HTMLElement, lines: readonly DiffLine[]): void {
  const table = parent.createDiv({ cls: "obsreview-diff obsreview-diff-split" });
  const rows = alignSplitRows(lines);
  for (const row of rows) {
    renderSplitCell(table, row.left, "left");
    renderSplitCell(table, row.right, "right");
  }
}

interface SplitRow {
  readonly left: DiffLine | null;
  readonly right: DiffLine | null;
}

function alignSplitRows(lines: readonly DiffLine[]): readonly SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "remove") {
      const item = lines[index];
      if (item !== undefined) removed.push(item);
      index += 1;
    }
    while (lines[index]?.kind === "add") {
      const item = lines[index];
      if (item !== undefined) added.push(item);
      index += 1;
    }
    const count = Math.max(removed.length, added.length);
    for (let pair = 0; pair < count; pair += 1) {
      rows.push({ left: removed[pair] ?? null, right: added[pair] ?? null });
    }
    if (count === 0) index += 1;
  }
  return rows;
}

function renderSplitCell(parent: HTMLElement, line: DiffLine | null, side: "left" | "right"): void {
  const cell = parent.createDiv({
    cls: `obsreview-split-cell is-${side} ${line === null ? "is-empty" : `is-${line.kind}`}`,
  });
  if (line === null) return;
  const number = side === "left" ? line.oldLine : line.newLine;
  cell.createSpan({ cls: "obsreview-line-number", text: number?.toString() ?? "" });
  const content = cell.createSpan({ cls: "obsreview-line-content" });
  renderLineContent(content, line, side);
}

function renderLineContent(
  parent: HTMLElement,
  line: DiffLine,
  side?: "left" | "right",
): void {
  const fragments =
    side === "left"
      ? line.oldInline
      : side === "right"
        ? line.newInline
        : line.kind === "remove"
          ? line.oldInline
          : line.kind === "add"
            ? line.newInline
            : undefined;
  if (fragments === undefined) {
    renderCjkWrappedText(parent, stripLineEnding(line.content) || " ");
    return;
  }
  renderFragments(parent, fragments);
}

function renderFragments(parent: HTMLElement, fragments: readonly InlineFragment[]): void {
  const text = fragments.map((fragment) => fragment.text).join("");
  let cursor = 0;
  for (const range of findCjkWrapRanges(text)) {
    renderFragmentSlice(parent, fragments, { from: cursor, to: range.from });
    const wrapper = parent.createSpan({ cls: "obsreview-cjk-wrap" });
    renderFragmentSlice(wrapper, fragments, range);
    cursor = range.to;
  }
  renderFragmentSlice(parent, fragments, { from: cursor, to: text.length });
}

function renderFragmentSlice(
  parent: HTMLElement,
  fragments: readonly InlineFragment[],
  range: TextRange,
): void {
  let offset = 0;
  for (const fragment of fragments) {
    const fragmentEnd = offset + fragment.text.length;
    const sliceStart = Math.max(range.from, offset);
    const sliceEnd = Math.min(range.to, fragmentEnd);
    if (sliceEnd <= sliceStart) {
      offset = fragmentEnd;
      continue;
    }
    parent.createSpan({
      cls: `obsreview-inline is-${fragment.kind}`,
      text: fragment.text.slice(sliceStart - offset, sliceEnd - offset),
    });
    offset = fragmentEnd;
  }
}

function addButton(request: HunkButtonRequest): void {
  const button = request.parent.createEl("button", {
    text: request.label,
    cls: request.className,
  });
  button.addEventListener("click", () => void request.action());
}
