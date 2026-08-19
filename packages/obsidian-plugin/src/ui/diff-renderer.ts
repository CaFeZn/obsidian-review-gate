import type {
  DiffHunk,
  DiffLine,
  InlineFragment,
} from "../../../core/src/diff/types";
import { stripLineEnding } from "../../../core/src/diff/text-lines";

export type DiffMode = "unified" | "split";

export interface HunkCallbacks {
  readonly onAccept?: (hunk: DiffHunk) => void | Promise<void>;
  readonly onReject?: (hunk: DiffHunk) => void | Promise<void>;
  readonly decision?: "accepted" | "rejected";
  readonly readOnly?: boolean;
}

export function renderHunk(
  parent: HTMLElement,
  hunk: DiffHunk,
  mode: DiffMode,
  callbacks: HunkCallbacks,
): HTMLElement {
  const section = parent.createDiv({ cls: "obsreview-hunk" });
  section.id = `obsreview-hunk-${hunk.id}`;
  const header = section.createDiv({ cls: "obsreview-hunk-header" });
  header.createEl("code", {
    text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  });
  if (callbacks.decision !== undefined) {
    header.createSpan({
      cls: `obsreview-hunk-decision is-${callbacks.decision}`,
      text: callbacks.decision,
    });
  }
  if (callbacks.readOnly !== true && callbacks.onAccept !== undefined && callbacks.onReject !== undefined) {
    const actions = header.createDiv({ cls: "obsreview-hunk-actions" });
    addButton(actions, "Accept hunk", "obsreview-accept", () => callbacks.onAccept?.(hunk));
    addButton(actions, "Reject hunk", "obsreview-reject", () => callbacks.onReject?.(hunk));
  }

  if (mode === "split") renderSplit(section, hunk.lines);
  else renderUnified(section, hunk.lines);
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
    parent.textContent = stripLineEnding(line.content) || " ";
    return;
  }
  renderFragments(parent, fragments);
}

function renderFragments(parent: HTMLElement, fragments: readonly InlineFragment[]): void {
  for (const fragment of fragments) {
    parent.createSpan({
      cls: `obsreview-inline is-${fragment.kind}`,
      text: fragment.text,
    });
  }
}

function addButton(
  parent: HTMLElement,
  label: string,
  className: string,
  action: () => void | Promise<void> | undefined,
): void {
  const button = parent.createEl("button", { text: label, cls: className });
  button.addEventListener("click", () => void action());
}
