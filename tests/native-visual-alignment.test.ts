import assert from "node:assert/strict";
import test from "node:test";
import {
  bindNativeVisualAlignment,
  planNativePixelAlignment,
  type NativeVisualAlignmentObserver,
  type NativeVisualAlignmentSurface,
} from "../packages/obsidian-plugin/src/editor/native-visual-alignment";

test("native visual alignment compensates the exact height of a soft-wrapped row", () => {
  const plan = planNativePixelAlignment(
    [
      { key: "hunk-1:0", bottom: 24 },
      { key: "hunk-1:1", bottom: 48 },
    ],
    [
      { key: "hunk-1:0", bottom: 72 },
      { key: "hunk-1:1", bottom: 96 },
    ],
  );

  assert.deepEqual(plan, {
    baseExtraPixels: { "hunk-1:0": 48 },
    proposalExtraPixels: {},
    anchors: [
      { base: 72, proposal: 72 },
      { base: 96, proposal: 96 },
    ],
  });
});

class TestStyle {
  public readonly values = new Map<string, string>();

  public setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  public removeProperty(name: string): string {
    const previous = this.values.get(name) ?? "";
    this.values.delete(name);
    return previous;
  }
}

class TestAlignmentRow {
  public readonly style = new TestStyle();

  public constructor(
    public readonly key: string,
    public bottom: number,
  ) {}

  public getAttribute(name: string): string | null {
    return name === "data-obsreview-align-key" ? this.key : null;
  }

  public getBoundingClientRect(): { readonly bottom: number } {
    return { bottom: this.bottom };
  }
}

class TestAlignmentSurface extends EventTarget implements NativeVisualAlignmentSurface {
  public readonly clientHeight = 100;
  public readonly scrollHeight = 1_100;
  public scrollTop = 0;

  public constructor(public rows: TestAlignmentRow[]) {
    super();
  }

  public getBoundingClientRect(): { readonly top: number } {
    return { top: 0 };
  }

  public querySelectorAll(): ArrayLike<unknown> {
    return this.rows;
  }
}

class TestAlignmentObserver implements NativeVisualAlignmentObserver {
  public disconnected = false;

  public constructor(
    public readonly callback: () => void,
    private readonly notifyWhenObserved = false,
  ) {}

  public observe(): void {
    if (this.notifyWhenObserved) this.callback();
  }

  public disconnect(): void {
    this.disconnected = true;
  }
}

test("native visual alignment remeasures wrapped rows after layout changes", () => {
  const baseRows = [
    new TestAlignmentRow("hunk-1:0", 24),
    new TestAlignmentRow("hunk-1:1", 48),
  ];
  const proposalRows = [
    new TestAlignmentRow("hunk-1:0", 72),
    new TestAlignmentRow("hunk-1:1", 96),
  ];
  const base = new TestAlignmentSurface(baseRows);
  const proposal = new TestAlignmentSurface(proposalRows);
  const frames: FrameRequestCallback[] = [];
  const observers: TestAlignmentObserver[] = [];
  const binding = bindNativeVisualAlignment(base, proposal, {
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => undefined,
    createResizeObserver: (callback) => {
      const observer = new TestAlignmentObserver(callback, true);
      observers.push(observer);
      return observer;
    },
    createMutationObserver: (callback) => {
      const observer = new TestAlignmentObserver(callback);
      observers.push(observer);
      return observer;
    },
  });

  assert.equal(baseRows[0]?.style.values.get("--obsreview-alignment-extra"), "48px");
  assert.deepEqual(binding.anchors(), [
    { base: 72, proposal: 72 },
    { base: 96, proposal: 96 },
  ]);

  baseRows[0]!.bottom = 72;
  baseRows[1]!.bottom = 96;
  proposalRows[0]!.bottom = 24;
  proposalRows[1]!.bottom = 48;
  observers[0]?.callback();
  frames.shift()?.(0);
  assert.equal(frames.length, 0);

  assert.equal(baseRows[0]?.style.values.has("--obsreview-alignment-extra"), false);
  assert.equal(proposalRows[0]?.style.values.get("--obsreview-alignment-extra"), "48px");
  assert.deepEqual(binding.anchors(), [
    { base: 72, proposal: 72 },
    { base: 96, proposal: 96 },
  ]);

  const editedBaseRows = [
    new TestAlignmentRow("hunk-2:0", 24),
    new TestAlignmentRow("hunk-2:1", 48),
  ];
  const editedProposalRows = [
    new TestAlignmentRow("hunk-2:0", 72),
    new TestAlignmentRow("hunk-2:1", 96),
  ];
  base.rows = editedBaseRows;
  proposal.rows = editedProposalRows;
  observers[1]?.callback();
  frames.shift()?.(0);
  frames.shift()?.(0);

  assert.equal(editedBaseRows[0]?.style.values.get("--obsreview-alignment-extra"), "48px");
  assert.deepEqual(binding.anchors(), [
    { base: 72, proposal: 72 },
    { base: 96, proposal: 96 },
  ]);
  assert.equal(frames.length, 0);

  binding.destroy();
  assert.equal(editedBaseRows[0]?.style.values.has("--obsreview-alignment-extra"), false);
  assert.equal(observers.every((observer) => observer.disconnected), true);
});
