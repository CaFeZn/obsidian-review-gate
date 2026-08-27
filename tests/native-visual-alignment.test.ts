import assert from "node:assert/strict";
import test from "node:test";
import {
  bindNativeVisualAlignment,
  planNativePixelAlignment,
  type NativeVisualAlignmentObserver,
  type NativeVisualAlignmentStyleSheet,
  type NativeVisualAlignmentSurface,
} from "../packages/obsidian-plugin/src/editor/native-visual-alignment";

test("native visual alignment compensates the exact height of a soft-wrapped row", () => {
  const plan = planNativePixelAlignment(
    [
      { key: "hunk-1:0", top: 0, bottom: 24 },
      { key: "hunk-1:1", top: 24, bottom: 48 },
    ],
    [
      { key: "hunk-1:0", top: 0, bottom: 72 },
      { key: "hunk-1:1", top: 72, bottom: 96 },
    ],
  );

  assert.deepEqual(plan, {
    baseBeforePixels: {},
    proposalBeforePixels: {},
    baseExtraPixels: { "hunk-1:0": 48 },
    proposalExtraPixels: {},
    anchors: [
      { base: 72, proposal: 72 },
      { base: 96, proposal: 96 },
    ],
  });
});

test("native visual alignment moves an early unchanged heading to the peer top", () => {
  const plan = planNativePixelAlignment(
    [{ key: "equal:goal", top: 24, bottom: 48 }],
    [{ key: "equal:goal", top: 72, bottom: 96 }],
  );

  assert.deepEqual(plan.baseBeforePixels, { "equal:goal": 48 });
  assert.deepEqual(plan.baseExtraPixels, {});
  assert.deepEqual(plan.anchors, [{ base: 96, proposal: 96 }]);
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
    public top: number,
    public bottom: number,
  ) {}

  public getAttribute(name: string): string | null {
    return name === "data-obsreview-align-key" ? this.key : null;
  }

  public getBoundingClientRect(): { readonly top: number; readonly bottom: number } {
    return { top: this.top, bottom: this.bottom };
  }
}

class TestAlignmentSurface extends EventTarget implements NativeVisualAlignmentSurface {
  public readonly clientHeight = 100;
  public readonly scrollHeight = 1_100;
  public scrollTop = 0;

  public constructor(
    public rows: TestAlignmentRow[],
    private readonly surfaceTop = 0,
  ) {
    super();
  }

  public getBoundingClientRect(): { readonly top: number } {
    return { top: this.surfaceTop };
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

class TestAlignmentStyleSheet implements NativeVisualAlignmentStyleSheet {
  public before: Readonly<Record<string, number>> = {};
  public after: Readonly<Record<string, number>> = {};
  public destroyed = false;

  public update(
    before: Readonly<Record<string, number>>,
    after: Readonly<Record<string, number>>,
  ): void {
    this.before = before;
    this.after = after;
  }

  public destroy(): void {
    this.destroyed = true;
  }
}

test("native visual alignment applies before spacing to an early unchanged heading", () => {
  const baseRow = new TestAlignmentRow("equal:goal", 24, 48);
  const proposalRow = new TestAlignmentRow("equal:goal", 72, 96);
  const base = new TestAlignmentSurface([baseRow]);
  const proposal = new TestAlignmentSurface([proposalRow]);
  const binding = bindNativeVisualAlignment(base, proposal, {
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    createResizeObserver: (callback) => new TestAlignmentObserver(callback),
    createMutationObserver: (callback) => new TestAlignmentObserver(callback),
  });

  assert.equal(baseRow.style.values.get("--obsreview-alignment-before"), "48px");
  assert.equal(baseRow.style.values.has("--obsreview-alignment-extra"), false);
  assert.deepEqual(binding.anchors(), [{ base: 96, proposal: 96 }]);

  binding.destroy();
  assert.equal(baseRow.style.values.has("--obsreview-alignment-before"), false);
});

test("native visual alignment includes unequal pane header heights", () => {
  const baseRow = new TestAlignmentRow("equal:goal", 24, 48);
  const proposalRow = new TestAlignmentRow("equal:goal", 72, 96);
  const base = new TestAlignmentSurface([baseRow], 0);
  const proposal = new TestAlignmentSurface([proposalRow], 48);
  const styleSheets: TestAlignmentStyleSheet[] = [];
  const binding = bindNativeVisualAlignment(base, proposal, {
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    createResizeObserver: (callback) => new TestAlignmentObserver(callback),
    createMutationObserver: (callback) => new TestAlignmentObserver(callback),
    createStyleSheet: () => {
      const styleSheet = new TestAlignmentStyleSheet();
      styleSheets.push(styleSheet);
      return styleSheet;
    },
  });

  assert.equal(baseRow.style.values.get("--obsreview-alignment-before"), "48px");
  assert.deepEqual(styleSheets[0]?.before, { "equal:goal": 48 });
  assert.deepEqual(styleSheets[1]?.before, {});
  assert.deepEqual(binding.anchors(), [{ base: 96, proposal: 96 }]);
  binding.destroy();
  assert.equal(styleSheets.every((styleSheet) => styleSheet.destroyed), true);
});

test("native visual alignment remeasures wrapped rows after layout changes", () => {
  const baseRows = [
    new TestAlignmentRow("hunk-1:0", 0, 24),
    new TestAlignmentRow("hunk-1:1", 24, 48),
  ];
  const proposalRows = [
    new TestAlignmentRow("hunk-1:0", 0, 72),
    new TestAlignmentRow("hunk-1:1", 72, 96),
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
  baseRows[1]!.top = 72;
  baseRows[1]!.bottom = 96;
  proposalRows[0]!.bottom = 24;
  proposalRows[1]!.top = 24;
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
    new TestAlignmentRow("hunk-2:0", 0, 24),
    new TestAlignmentRow("hunk-2:1", 24, 48),
  ];
  const editedProposalRows = [
    new TestAlignmentRow("hunk-2:0", 0, 72),
    new TestAlignmentRow("hunk-2:1", 72, 96),
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
