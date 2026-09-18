import type { Editor, MarkdownView } from "obsidian";
import {
  bindNativeDiffEditors,
  type NativeCodeMirrorEditor,
} from "./native-diff-extension";
import { planNativeDiffBlocks } from "./native-diff-plan";
import {
  bindNativeScrollContainers,
  isNativeScrollContainer,
} from "./native-scroll-sync";
import { bindNativeRenderedDiffBlocks } from "./native-rendered-diff-blocks";
import { activateNativeHunk, focusNativeHunk } from "./native-hunk-focus";
import {
  bindNativeVisualAlignment,
  isNativeVisualAlignmentSurface,
} from "./native-visual-alignment";

export { bindNativeDiffEditors } from "./native-diff-extension";
export { planNativeDiffBlocks } from "./native-diff-plan";

export interface NativeDiffPairController {
  focusHunk(index: number): void;
  destroy(): void;
}

interface NativeDiffPairContent {
  readonly base: string;
  readonly proposal: string;
}

export async function createNativeDiffPair(
  baseView: MarkdownView,
  proposalView: MarkdownView,
  content: NativeDiffPairContent,
): Promise<NativeDiffPairController> {
  const baseEditor = codeMirrorView(baseView);
  const proposalEditor = codeMirrorView(proposalView);
  if (baseEditor === null || proposalEditor === null) {
    throw new Error("Obsidian native CodeMirror editor is unavailable.");
  }
  if (
    !isNativeVisualAlignmentSurface(baseEditor.scrollDOM) ||
    !isNativeVisualAlignmentSurface(proposalEditor.scrollDOM)
  ) {
    throw new Error("Obsidian native CodeMirror layout surface is unavailable.");
  }

  let blocks = planNativeDiffBlocks(content.base, content.proposal);
  let active = true;
  const diffBinding = bindNativeDiffEditors(baseEditor, proposalEditor, content.base);
  const renderedDiffBinding = bindNativeRenderedDiffBlocks(
    baseEditor,
    proposalEditor,
    content.base,
  );
  const visualAlignmentBinding = bindNativeVisualAlignment(
    baseEditor.scrollDOM,
    proposalEditor.scrollDOM,
  );
  const scrollBinding = bindNativeScrollContainers(
    baseEditor.scrollDOM,
    proposalEditor.scrollDOM,
    { anchors: visualAlignmentBinding.anchors },
  );
  return {
    focusHunk: (index) => {
      scrollBinding.suspendUntilScrollIdle();
      blocks = planNativeDiffBlocks(content.base, proposalView.getViewData());
      const focused = focusNativeHunk(baseEditor, proposalEditor, blocks, index);
      if (focused === null) return;
      const block = blocks[normalizeIndex(index, blocks.length)];
      if (block === undefined) return;
      scrollToLine(baseView.editor, block.baseStart);
      scrollToLine(proposalView.editor, block.proposalStart);
      setTimeout(() => {
        if (active) activateNativeHunk(baseEditor, proposalEditor, focused.label);
      }, 0);
    },
    destroy: () => {
      active = false;
      scrollBinding.destroy();
      visualAlignmentBinding.destroy();
      renderedDiffBinding.destroy();
      diffBinding.destroy();
    },
  };
}

export function isNativeCodeMirrorEditor(
  candidate: unknown,
): candidate is NativeCodeMirrorEditor {
  if (candidate === null || typeof candidate !== "object") return false;
  const state: unknown = Reflect.get(candidate, "state");
  const scrollDOM: unknown = Reflect.get(candidate, "scrollDOM");
  return (
    state !== null &&
    typeof state === "object" &&
    typeof Reflect.get(candidate, "dispatch") === "function" &&
    typeof Reflect.get(candidate, "focus") === "function" &&
    isNativeScrollContainer(scrollDOM)
  );
}

function codeMirrorView(view: MarkdownView): NativeCodeMirrorEditor | null {
  const candidate: unknown = Reflect.get(view.editor, "cm");
  return isNativeCodeMirrorEditor(candidate) ? candidate : null;
}

function scrollToLine(editor: Editor, oneBasedLine: number): void {
  const line = Math.min(editor.lastLine(), Math.max(0, oneBasedLine - 1));
  editor.scrollIntoView(
    { from: { line, ch: 0 }, to: { line, ch: editor.getLine(line).length } },
    true,
  );
}

function normalizeIndex(index: number, length: number): number {
  return length === 0 ? 0 : ((index % length) + length) % length;
}
