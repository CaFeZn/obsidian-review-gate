import type { EditorState } from "@codemirror/state";
import {
  planNativeDiffBlocks,
  planNativeEqualLinePairs,
  type NativeDiffBlock,
  type NativeDiffSide,
  type NativeEqualLinePair,
} from "./native-diff-plan";

export interface NativeRenderedDiffBlock {
  readonly label: string;
  readonly baseLines: readonly number[];
  readonly proposalLines: readonly number[];
}

export interface NativeRenderedDiffState {
  readonly kind: "add" | "remove";
  readonly label: string;
}

/**
 * Expands changed source lines to the complete Markdown block rendered by
 * Obsidian, so a changed table row or Callout body marks the visible widget.
 */
export function planNativeRenderedDiffBlocks(
  base: string,
  proposal: string,
): readonly NativeDiffBlock[] {
  return planNativeDiffBlocks(base, proposal).map((block) => ({
    ...block,
    label: block.label,
    baseLines: expandRenderedBlockLines(base, block.baseLines),
    proposalLines: expandRenderedBlockLines(proposal, block.proposalLines),
  }));
}

export interface NativeRenderedChangedLine {
  readonly line: number;
  readonly text: string;
}

export interface NativeRenderedChangedLines {
  readonly base: readonly NativeRenderedChangedLine[];
  readonly proposal: readonly NativeRenderedChangedLine[];
}

/**
 * Collects the exact changed source lines and their text on each side, so a
 * rendered table row or Callout paragraph can be marked individually instead of
 * tinting the whole widget.
 */
export function planNativeRenderedChangedLines(
  base: string,
  proposal: string,
): NativeRenderedChangedLines {
  const blocks = planNativeDiffBlocks(base, proposal);
  return {
    base: changedLinesOfSide(blocks, "base", base.split(/\r?\n/u)),
    proposal: changedLinesOfSide(blocks, "proposal", proposal.split(/\r?\n/u)),
  };
}

function changedLinesOfSide(
  blocks: readonly NativeDiffBlock[],
  side: NativeDiffSide,
  lines: readonly string[],
): readonly NativeRenderedChangedLine[] {
  const seen = new Set<number>();
  const changed: NativeRenderedChangedLine[] = [];
  for (const block of blocks) {
    for (const line of side === "base" ? block.baseLines : block.proposalLines) {
      if (seen.has(line)) continue;
      seen.add(line);
      changed.push({ line, text: lines[line - 1] ?? "" });
    }
  }
  return changed;
}

/**
 * Normalizes source Markdown and rendered text to the same skeleton so inline
 * syntax (`` ` ``, `**`, `|`, list markers) cannot break the comparison.
 */
export function normalizeNativeRenderedText(text: string): string {
  return text
    .replace(/^\s*>+\s?/u, "")
    .replace(/^\s*[-*+]\s+/u, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Reports whether a rendered row or paragraph carries the changed source text.
 * A table row matches by equality and a Callout paragraph by containment, since
 * Obsidian merges consecutive quoted lines into one paragraph.
 */
export function matchesNativeRenderedChangedText(
  partText: string,
  changedTexts: readonly string[],
): boolean {
  const normalizedPart = normalizeNativeRenderedText(partText);
  if (normalizedPart.length === 0) return false;
  return changedTexts.some((changed) => {
    const normalizedChanged = normalizeNativeRenderedText(changed);
    return (
      normalizedChanged.length >= 4 && normalizedPart.includes(normalizedChanged)
    );
  });
}

interface NativeRenderedDiffEditor {
  readonly scrollDOM: Node & ParentNode;
  readonly state: EditorState;
  posAtDOM(node: Node): number;
}

export interface NativeRenderedDiffBinding {
  destroy(): void;
}

const RENDERED_BLOCK_SELECTOR = ".cm-embed-block";
const RENDERED_ADD_CLASS = "obsreview-native-rendered-add";
const RENDERED_REMOVE_CLASS = "obsreview-native-rendered-remove";
const RENDERED_ROW_CLASS = "obsreview-native-rendered-row";
const RENDERED_DIFF_ATTRIBUTE = "data-obsreview-rendered-diff";
const HUNK_ATTRIBUTE = "data-obsreview-hunk";
const ALIGNMENT_KEY_ATTRIBUTE = "data-obsreview-align-key";

export function classifyNativeRenderedDiffBlock(
  blocks: readonly NativeRenderedDiffBlock[],
  side: NativeDiffSide,
  lineNumber: number,
): NativeRenderedDiffState | null {
  const kind = side === "base" ? "remove" : "add";
  for (const block of blocks) {
    const lines = side === "base" ? block.baseLines : block.proposalLines;
    if (lines.includes(lineNumber)) return { kind, label: block.label };
  }
  return null;
}

export function nativeRenderedAlignmentKey(
  pairs: readonly NativeEqualLinePair[],
  side: NativeDiffSide,
  lineNumber: number,
): string | null {
  for (const pair of pairs) {
    const pairedLine = side === "base" ? pair.baseLine : pair.proposalLine;
    if (pairedLine === lineNumber) return pair.alignmentKey;
  }
  return null;
}

export function bindNativeRenderedDiffBlocks(
  baseEditor: unknown,
  proposalEditor: unknown,
  base: string,
): NativeRenderedDiffBinding {
  if (!isNativeRenderedDiffEditor(baseEditor) || !isNativeRenderedDiffEditor(proposalEditor)) {
    return { destroy: () => undefined };
  }

  let active = true;
  let frame: number | null = null;
  const refresh = (): void => {
    if (!active) return;
    const proposal = proposalEditor.state.doc.toString();
    const blocks = planNativeRenderedDiffBlocks(base, proposal);
    const changedLines = planNativeRenderedChangedLines(base, proposal);
    const equalPairs = planNativeEqualLinePairs(base, proposal);
    decorateRenderedBlocks(baseEditor, blocks, changedLines, equalPairs, "base");
    decorateRenderedBlocks(proposalEditor, blocks, changedLines, equalPairs, "proposal");
  };
  const schedule = (): void => {
    if (!active || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      refresh();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(baseEditor.scrollDOM, { childList: true, subtree: true });
  observer.observe(proposalEditor.scrollDOM, { childList: true, subtree: true });
  refresh();

  return {
    destroy: () => {
      if (!active) return;
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      observer.disconnect();
      clearRenderedBlocks(baseEditor);
      clearRenderedBlocks(proposalEditor);
    },
  };
}

function decorateRenderedBlocks(
  editor: NativeRenderedDiffEditor,
  blocks: readonly NativeDiffBlock[],
  changedLines: NativeRenderedChangedLines,
  equalPairs: readonly NativeEqualLinePair[],
  side: NativeDiffSide,
): void {
  for (const candidate of Array.from(editor.scrollDOM.querySelectorAll(RENDERED_BLOCK_SELECTOR))) {
    if (!(candidate instanceof HTMLElement)) continue;
    clearRenderedBlock(candidate);
    let position: number;
    try {
      position = editor.posAtDOM(candidate);
    } catch {
      continue;
    }
    const lineNumber = editor.state.doc.lineAt(position).number;
    const alignmentKey = nativeRenderedAlignmentKey(equalPairs, side, lineNumber);
    if (alignmentKey !== null) {
      candidate.setAttribute(ALIGNMENT_KEY_ATTRIBUTE, alignmentKey);
    }
    const state = classifyNativeRenderedDiffBlock(blocks, side, lineNumber);
    if (state === null) continue;
    candidate.classList.add(
      state.kind === "add" ? RENDERED_ADD_CLASS : RENDERED_REMOVE_CLASS,
    );
    candidate.setAttribute(RENDERED_DIFF_ATTRIBUTE, state.kind);
    candidate.setAttribute(HUNK_ATTRIBUTE, state.label);
    markRenderedParts(
      candidate,
      state.kind,
      (side === "base" ? changedLines.base : changedLines.proposal).map(
        (changed) => changed.text,
      ),
    );
  }
}

/**
 * Tints only the rendered rows or Callout paragraphs whose text carries a
 * changed source line, so unchanged siblings inside the same widget stay
 * neutral instead of inheriting the whole-block fill.
 */
function markRenderedParts(
  candidate: HTMLElement,
  kind: "add" | "remove",
  changedTexts: readonly string[],
): void {
  const parts = candidate.querySelectorAll(
    "table tr, .callout-content > p, .callout-content > ul > li, .callout-content > ol > li",
  );
  for (const part of Array.from(parts)) {
    if (!(part instanceof HTMLElement)) continue;
    if (!matchesNativeRenderedChangedText(part.textContent ?? "", changedTexts)) continue;
    part.classList.add(RENDERED_ROW_CLASS);
    part.setAttribute(RENDERED_DIFF_ATTRIBUTE, kind);
  }
}

function clearRenderedBlocks(editor: NativeRenderedDiffEditor): void {
  for (const candidate of Array.from(editor.scrollDOM.querySelectorAll(RENDERED_BLOCK_SELECTOR))) {
    if (candidate instanceof HTMLElement) clearRenderedBlock(candidate);
  }
}

function clearRenderedBlock(element: HTMLElement): void {
  element.classList.remove(RENDERED_ADD_CLASS, RENDERED_REMOVE_CLASS);
  element.removeAttribute(RENDERED_DIFF_ATTRIBUTE);
  element.removeAttribute(HUNK_ATTRIBUTE);
  element.removeAttribute(ALIGNMENT_KEY_ATTRIBUTE);
  for (const part of Array.from(element.querySelectorAll(`.${RENDERED_ROW_CLASS}`))) {
    part.classList.remove(RENDERED_ROW_CLASS);
    part.removeAttribute(RENDERED_DIFF_ATTRIBUTE);
  }
}

function expandRenderedBlockLines(
  source: string,
  changedLines: readonly number[],
): readonly number[] {
  const lines = source.split(/\r?\n/u);
  const expanded = new Set(changedLines);
  for (const lineNumber of changedLines) {
    const range = renderedBlockRange(lines, lineNumber);
    if (range === null) continue;
    for (let line = range.start; line <= range.end; line += 1) {
      expanded.add(line);
    }
  }
  return [...expanded].sort((left, right) => left - right);
}

function renderedBlockRange(
  lines: readonly string[],
  lineNumber: number,
): { readonly start: number; readonly end: number } | null {
  const index = lineNumber - 1;
  if (index < 0 || index >= lines.length) return null;
  const callout = calloutRange(lines, index);
  if (callout !== null) return callout;
  return tableRange(lines, index);
}

function calloutRange(
  lines: readonly string[],
  index: number,
): { readonly start: number; readonly end: number } | null {
  if (!isBlockquoteLine(lines[index] ?? "")) return null;
  let start = index;
  while (start > 0 && isBlockquoteLine(lines[start - 1] ?? "")) start -= 1;
  if (!/^\s*>\s*\[![^\]]+\]/u.test(lines[start] ?? "")) return null;
  let end = index;
  while (end + 1 < lines.length && isBlockquoteLine(lines[end + 1] ?? "")) {
    end += 1;
  }
  return { start: start + 1, end: end + 1 };
}

function tableRange(
  lines: readonly string[],
  index: number,
): { readonly start: number; readonly end: number } | null {
  if (!isTableRow(lines[index] ?? "")) return null;
  let start = index;
  while (start > 0 && isTableRow(lines[start - 1] ?? "")) start -= 1;
  let end = index;
  while (end + 1 < lines.length && isTableRow(lines[end + 1] ?? "")) end += 1;
  if (!lines.slice(start, end + 1).some(isTableDelimiter)) return null;
  return { start: start + 1, end: end + 1 };
}

function isBlockquoteLine(line: string): boolean {
  return /^\s*>/u.test(line);
}

function isTableRow(line: string): boolean {
  const value = line.trim();
  return value.length > 0 && value.includes("|") && !value.startsWith(">");
}

function isTableDelimiter(line: string): boolean {
  const value = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = value.split("|").map((cell) => cell.trim());
  return (
    cells.length >= 2 &&
    // Obsidian renders aligned tables such as `| --: | ---- |`, so a cell only
    // needs one hyphen. Requiring three silently rejected those tables and made
    // every changed row inside them unmarked.
    cells.every((cell) => /^:?-+:?$/u.test(cell))
  );
}

function isNativeRenderedDiffEditor(candidate: unknown): candidate is NativeRenderedDiffEditor {
  if (candidate === null || typeof candidate !== "object") return false;
  const state: unknown = Reflect.get(candidate, "state");
  const scrollDOM: unknown = Reflect.get(candidate, "scrollDOM");
  return (
    state !== null &&
    typeof state === "object" &&
    scrollDOM !== null &&
    typeof scrollDOM === "object" &&
    typeof Reflect.get(scrollDOM, "querySelectorAll") === "function" &&
    typeof Reflect.get(candidate, "posAtDOM") === "function"
  );
}
