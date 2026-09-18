import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import test from "node:test";
import { focusNativeHunk } from "../packages/obsidian-plugin/src/editor/native-hunk-focus";

test("focusing a native hunk selects the proposal line and marks only that hunk", () => {
  const baseSurface = new FakeSurface(["hunk-1", "hunk-2"]);
  const proposalSurface = new FakeSurface(["hunk-1", "hunk-2"]);
  const baseEditor = new FakeEditor("one\ntwo\nthree\n", baseSurface);
  const proposalEditor = new FakeEditor("one\nTWO\nthree\n", proposalSurface);
  const blocks = [
    block("hunk-1", 1),
    block("hunk-2", 3),
  ];

  const result = focusNativeHunk(baseEditor, proposalEditor, blocks, 1);

  assert.deepEqual(result, { label: "hunk-2", proposalLine: 3 });
  assert.equal(proposalEditor.focused, true);
  assert.equal(proposalEditor.selectedLine, 3);
  assert.deepEqual(baseSurface.activeLabels(), ["hunk-2"]);
  assert.deepEqual(proposalSurface.activeLabels(), ["hunk-2"]);
});

function block(label: string, proposalStart: number) {
  return {
    label,
    baseStart: proposalStart,
    proposalStart,
    baseLines: [proposalStart],
    proposalLines: [proposalStart],
    baseSpacerLines: 0,
    proposalSpacerLines: 0,
  };
}

class FakeEditor {
  public readonly state: EditorState;
  public focused = false;
  public selectedLine = 0;

  public constructor(
    content: string,
    public readonly scrollDOM: FakeSurface,
  ) {
    this.state = EditorState.create({ doc: content });
  }

  public dispatch(spec: { readonly selection?: { readonly anchor: number } }): void {
    if (spec.selection === undefined) return;
    this.selectedLine = this.state.doc.lineAt(spec.selection.anchor).number;
  }

  public focus(): void {
    this.focused = true;
  }
}

class FakeSurface {
  public readonly clientHeight = 100;
  public readonly scrollHeight = 200;
  public scrollTop = 0;
  private readonly nodes: FakeHunkNode[];

  public constructor(labels: readonly string[]) {
    this.nodes = labels.map((label) => new FakeHunkNode(label));
  }

  public querySelectorAll(): readonly FakeHunkNode[] {
    return this.nodes;
  }

  public addEventListener(): void {}

  public removeEventListener(): void {}

  public activeLabels(): readonly string[] {
    return this.nodes.filter((node) => node.active).map((node) => node.label);
  }
}

class FakeHunkNode {
  public active = false;
  public readonly classList = {
    toggle: (_name: string, active: boolean) => {
      this.active = active;
    },
  };

  public constructor(public readonly label: string) {}

  public getAttribute(name: string): string | null {
    return name === "data-obsreview-hunk" ? this.label : null;
  }
}
