import type { Range, Text } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import type { DiffHunk, DiffLine } from "../../../core/src/diff/types";
import { nativeHunkLabel, type NativeDiffSide } from "./native-diff-plan";

interface NativeAlignmentSpacerRequest {
  readonly documentValue: Text;
  readonly side: NativeDiffSide;
  readonly hunk: DiffHunk;
  readonly changedLines: readonly DiffLine[];
  readonly spacerLines: number;
  readonly alignmentKeys: readonly string[];
  readonly active: boolean;
}

export function buildNativeAlignmentSpacerDecoration(
  request: NativeAlignmentSpacerRequest,
): Range<Decoration> {
  const label = request.changedLines.length === 0 ? nativeHunkLabel(request.hunk) : undefined;
  const anchor = alignmentAnchor(request);
  return Decoration.widget({
    widget: new NativeDiffAlignmentWidget(
      request.side,
      request.spacerLines,
      request.alignmentKeys,
      label,
      request.active,
    ),
    block: true,
    side: anchor.side,
    obsreviewSpacerLines: request.spacerLines,
    obsreviewAlignmentKeys: request.alignmentKeys,
    obsreviewHunkLabel: label,
  }).range(anchor.position);
}

class NativeDiffAlignmentWidget extends WidgetType {
  public constructor(
    private readonly side: NativeDiffSide,
    private readonly spacerLines: number,
    private readonly alignmentKeys: readonly string[],
    private readonly label: string | undefined,
    private readonly active: boolean,
  ) {
    super();
  }

  public override eq(widget: WidgetType): boolean {
    return (
      widget instanceof NativeDiffAlignmentWidget &&
      widget.side === this.side &&
      widget.spacerLines === this.spacerLines &&
      widget.alignmentKeys.length === this.alignmentKeys.length &&
      widget.alignmentKeys.every((key, index) => key === this.alignmentKeys[index]) &&
      widget.label === this.label &&
      widget.active === this.active
    );
  }

  public override toDOM(): HTMLElement {
    const container = document.createElement("div");
    const classes = ["obsreview-native-alignment-spacer", `is-${this.side}`];
    if (this.label !== undefined) classes.push("obsreview-native-hunk-start");
    classes.push("obsreview-native-hunk-end");
    if (this.active) classes.push("obsreview-native-hunk-active");
    container.className = classes.join(" ");
    container.setAttribute("aria-hidden", "true");
    if (this.label !== undefined) {
      const label = document.createElement("div");
      label.className = "obsreview-native-hunk-label";
      label.textContent = this.label;
      container.appendChild(label);
    }
    for (let index = 0; index < this.spacerLines; index += 1) {
      const line = document.createElement("div");
      line.className = "cm-line obsreview-native-spacer-line";
      const alignmentKey = this.alignmentKeys[index];
      if (alignmentKey !== undefined) {
        line.setAttribute("data-obsreview-align-key", alignmentKey);
      }
      line.textContent = "\u200b";
      container.appendChild(line);
    }
    return container;
  }
}

function alignmentAnchor(request: NativeAlignmentSpacerRequest): {
  readonly position: number;
  readonly side: -1 | 1;
} {
  const lastChangedLine = request.changedLines.at(-1);
  if (lastChangedLine !== undefined) {
    const lineNumber =
      request.side === "base" ? lastChangedLine.oldLine : lastChangedLine.newLine;
    const line = request.documentValue.line(
      Math.min(request.documentValue.lines, Math.max(1, lineNumber ?? 1)),
    );
    return { position: line.to, side: 1 };
  }
  const requested = request.side === "base" ? request.hunk.oldStart : request.hunk.newStart;
  if (requested > request.documentValue.lines) {
    return { position: request.documentValue.length, side: 1 };
  }
  const line = request.documentValue.line(Math.max(1, requested));
  return { position: line.from, side: -1 };
}
