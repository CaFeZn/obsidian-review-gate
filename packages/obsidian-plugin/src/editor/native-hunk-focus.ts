import {
  setNativeActiveHunk,
  type NativeCodeMirrorEditor,
} from "./native-diff-extension";
import type { NativeDiffBlock } from "./native-diff-plan";

export interface NativeHunkFocusResult {
  readonly label: string;
  readonly proposalLine: number;
}

/**
 * Activates one hunk on both native panes and moves the proposal cursor to it.
 */
export function focusNativeHunk(
  baseEditor: NativeCodeMirrorEditor,
  proposalEditor: NativeCodeMirrorEditor,
  blocks: readonly NativeDiffBlock[],
  index: number,
): NativeHunkFocusResult | null {
  const block = blocks[normalizeIndex(index, blocks.length)];
  if (block === undefined) return null;

  const proposalLine = clampLine(proposalEditor, block.proposalStart);
  const line = proposalEditor.state.doc.line(proposalLine);
  proposalEditor.dispatch({
    selection: { anchor: line.from, head: line.from },
  });
  proposalEditor.focus();
  activateNativeHunk(baseEditor, proposalEditor, block.label);

  return { label: block.label, proposalLine };
}

export function activateNativeHunk(
  baseEditor: NativeCodeMirrorEditor,
  proposalEditor: NativeCodeMirrorEditor,
  label: string,
): void {
  baseEditor.dispatch({ effects: setNativeActiveHunk.of(label) });
  proposalEditor.dispatch({ effects: setNativeActiveHunk.of(label) });
  setActiveHunk(baseEditor.scrollDOM, label);
  setActiveHunk(proposalEditor.scrollDOM, label);
}

function setActiveHunk(surface: unknown, label: string): void {
  if (
    surface === null ||
    (typeof surface !== "object" && typeof surface !== "function")
  ) {
    return;
  }
  const querySelectorAll = Reflect.get(surface, "querySelectorAll");
  if (typeof querySelectorAll !== "function") return;
  const candidates = Array.from(
    querySelectorAll.call(
      surface,
      "[data-obsreview-hunk], [data-obsreview-hunk-label]",
    ) as Iterable<unknown>,
  );
  for (const candidate of candidates) {
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    ) {
      continue;
    }
    const getAttribute = Reflect.get(candidate, "getAttribute");
    const classList = Reflect.get(candidate, "classList");
    if (classList === null || typeof classList !== "object") continue;
    const toggle = Reflect.get(classList, "toggle");
    if (typeof getAttribute !== "function" || typeof toggle !== "function") continue;
    const currentLabel =
      getAttribute.call(candidate, "data-obsreview-hunk-label") ??
      getAttribute.call(candidate, "data-obsreview-hunk");
    toggle.call(classList, "obsreview-native-hunk-active", currentLabel === label);
  }
}

function clampLine(editor: NativeCodeMirrorEditor, line: number): number {
  return Math.min(editor.state.doc.lines, Math.max(1, line));
}

function normalizeIndex(index: number, length: number): number {
  return length === 0 ? 0 : ((index % length) + length) % length;
}
