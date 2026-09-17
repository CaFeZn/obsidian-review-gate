import assert from "node:assert/strict";
import test from "node:test";
import {
  bindNativeScrollContainers,
  type NativeScrollContainer,
} from "../packages/obsidian-plugin/src/editor/native-scroll-sync";

class TestScrollContainer extends EventTarget implements NativeScrollContainer {
  public programmaticWrites = 0;
  public clientHeight: number;
  public scrollHeight: number;
  protected value = 0;

  public constructor(scrollHeight: number, clientHeight: number) {
    super();
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
  }

  public get scrollTop(): number {
    return this.value;
  }

  public set scrollTop(value: number) {
    this.programmaticWrites += 1;
    this.value = value;
    this.dispatchEvent(new Event("scroll"));
  }

  public scrollFromUser(value: number): void {
    this.value = value;
    this.dispatchEvent(new Event("scroll"));
  }
}

class DeferredQuantizedTestScrollContainer extends TestScrollContainer {
  private eventQueued = false;

  public override set scrollTop(value: number) {
    this.programmaticWrites += 1;
    this.value = Math.ceil(value * 3) / 3;
    this.eventQueued = true;
  }

  public override get scrollTop(): number {
    return this.value;
  }

  public flushProgrammaticScroll(): void {
    if (!this.eventQueued) return;
    this.eventQueued = false;
    this.dispatchEvent(new Event("scroll"));
  }
}

class QuantizedTestScrollContainer extends TestScrollContainer {
  public override set scrollTop(value: number) {
    super.scrollTop = Math.ceil(value * 3) / 3;
  }

  public override get scrollTop(): number {
    return super.scrollTop;
  }
}

/**
 * Reproduces CodeMirror block virtualization: the scrollable range grows while
 * the user scrolls, and any scrollTop beyond the current range is clamped by the
 * browser the same way a real viewport clamps it.
 */
class GrowingClampedTestScrollContainer extends TestScrollContainer {
  public maxScrollTop = Number.POSITIVE_INFINITY;

  public override set scrollTop(value: number) {
    const clamped = Math.max(0, Math.min(this.maxScrollTop, value));
    super.scrollTop = clamped;
  }

  public override get scrollTop(): number {
    return super.scrollTop;
  }
}

test("native scroll sync does not echo a clamped programmatic write back", () => {
  // Given: a target whose real range is smaller than the computed mapping and
  // that clamps the write the way a browser viewport does.
  const base = new TestScrollContainer(5_000, 100);
  const proposal = new GrowingClampedTestScrollContainer(2_000, 100);
  proposal.maxScrollTop = 500;
  const binding = bindNativeScrollContainers(base, proposal);

  // When: the user scrolls the base to a position that maps past the target range.
  base.scrollFromUser(4_000);

  // Then: the clamped target value must not be treated as a user scroll and
  // pulled back into the base.
  assert.equal(proposal.scrollTop, 500);
  assert.equal(base.programmaticWrites, 0);
  assert.equal(base.scrollTop, 4_000);
  binding.destroy();
});

test("native scroll sync re-maps once the target range grows", async () => {
  // Given: a virtualized target that reports a small range first, then grows.
  const base = new TestScrollContainer(5_000, 100);
  const proposal = new GrowingClampedTestScrollContainer(2_000, 100);
  proposal.maxScrollTop = 500;
  const binding = bindNativeScrollContainers(base, proposal);
  base.scrollFromUser(4_000);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // When: CodeMirror finishes measuring and the target can scroll further.
  proposal.scrollHeight = 5_000;
  proposal.maxScrollTop = 4_900;
  base.scrollFromUser(4_000);

  // Then: the target follows the newly available range instead of staying clamped.
  assert.equal(proposal.scrollTop, 4_000);
  binding.destroy();
});

test("native scroll sync drives the proposal when the base scrolls", () => {
  // Given: two equally scrollable native Markdown panes.
  const base = new TestScrollContainer(1_100, 100);
  const proposal = new TestScrollContainer(1_100, 100);
  const binding = bindNativeScrollContainers(base, proposal);

  // When: the user scrolls the base pane to 30%.
  base.scrollFromUser(300);

  // Then: the proposal follows without feeding a write back into the base.
  assert.equal(proposal.scrollTop, 300);
  assert.equal(base.programmaticWrites, 0);
  binding.destroy();
});

test("native scroll sync drives the base when the proposal scrolls", () => {
  // Given: two equally scrollable native Markdown panes.
  const base = new TestScrollContainer(1_100, 100);
  const proposal = new TestScrollContainer(1_100, 100);
  const binding = bindNativeScrollContainers(base, proposal);

  // When: the user scrolls the proposal pane to 70%.
  proposal.scrollFromUser(700);

  // Then: the base follows without feeding a write back into the proposal.
  assert.equal(base.scrollTop, 700);
  assert.equal(proposal.programmaticWrites, 0);
  binding.destroy();
});

test("native scroll sync maps unequal ranges by relative progress", () => {
  // Given: the proposal has twice the scrollable range of the base.
  const base = new TestScrollContainer(1_100, 100);
  const proposal = new TestScrollContainer(2_100, 100);
  const binding = bindNativeScrollContainers(base, proposal);

  // When: the user scrolls the base pane halfway through its range.
  base.scrollFromUser(500);

  // Then: the proposal moves halfway through its own range.
  assert.equal(proposal.scrollTop, 1_000);
  binding.destroy();
});

test("native scroll sync reads changed ranges and maps the bottom", () => {
  // Given: a bound pair whose editor heights change after CodeMirror measures content.
  const base = new TestScrollContainer(1_100, 100);
  const proposal = new TestScrollContainer(2_100, 100);
  const binding = bindNativeScrollContainers(base, proposal);
  base.scrollHeight = 2_100;
  proposal.scrollHeight = 4_100;

  // When: the user scrolls the newly measured base range to its bottom.
  base.scrollFromUser(2_000);

  // Then: the proposal uses its current range and reaches its own bottom.
  assert.equal(proposal.scrollTop, 4_000);
  binding.destroy();
});

test("native scroll sync absorbs subpixel target quantization", () => {
  // Given: the shorter pane quantizes scroll positions to device-pixel thirds.
  const base = new QuantizedTestScrollContainer(896, 100);
  const proposal = new TestScrollContainer(2_623, 100);
  const binding = bindNativeScrollContainers(base, proposal);

  // When: the user scrolls the proposal to a position that rounds the base upward.
  proposal.scrollFromUser(1_842);

  // Then: the rounded base position does not feed a corrective write into the proposal.
  assert.equal(base.programmaticWrites, 1);
  assert.equal(proposal.programmaticWrites, 0);
  binding.destroy();
});

test("native scroll sync suppresses delayed own writes at extreme range ratios", () => {
  // Given: a tall source and a short target that reports a delayed quantized scroll event.
  const base = new TestScrollContainer(1_000_100, 100);
  const proposal = new DeferredQuantizedTestScrollContainer(1_100, 100);
  const binding = bindNativeScrollContainers(base, proposal);

  // When: one user scroll drives the target and its programmatic event arrives later.
  base.scrollFromUser(123_456);
  proposal.flushProgrammaticScroll();

  // Then: target quantization is not amplified into a corrective source write.
  assert.equal(proposal.programmaticWrites, 1);
  assert.equal(base.programmaticWrites, 0);
  binding.destroy();
});

test("native scroll sync ignores a source without a scrollable range", () => {
  // Given: the base fits without scrolling and the proposal is already scrolled.
  const base = new TestScrollContainer(100, 100);
  const proposal = new TestScrollContainer(1_100, 100);
  proposal.scrollFromUser(400);
  proposal.programmaticWrites = 0;
  const binding = bindNativeScrollContainers(base, proposal);

  // When: the non-scrollable base emits a scroll event.
  base.scrollFromUser(0);

  // Then: it does not move the proposal to an arbitrary position.
  assert.equal(proposal.scrollTop, 400);
  assert.equal(proposal.programmaticWrites, 0);
  binding.destroy();
});

test("native scroll sync ignores a target without a scrollable range", () => {
  // Given: the proposal fits without scrolling and the base can scroll.
  const base = new TestScrollContainer(1_100, 100);
  const proposal = new TestScrollContainer(100, 100);
  const binding = bindNativeScrollContainers(base, proposal);

  // When: the user scrolls the base pane.
  base.scrollFromUser(400);

  // Then: the proposal receives no impossible scroll assignment.
  assert.equal(proposal.scrollTop, 0);
  assert.equal(proposal.programmaticWrites, 0);
  binding.destroy();
});

test("native scroll sync removes both listeners when destroyed", () => {
  // Given: a bound pair that has been closed.
  const base = new TestScrollContainer(1_100, 100);
  const proposal = new TestScrollContainer(1_100, 100);
  const binding = bindNativeScrollContainers(base, proposal);
  binding.destroy();

  // When: either pane scrolls after cleanup.
  base.scrollFromUser(250);
  proposal.scrollFromUser(750);

  // Then: neither pane drives the other.
  assert.equal(base.scrollTop, 250);
  assert.equal(proposal.scrollTop, 750);
});

test("native scroll sync pauses while both panes focus a hunk", async () => {
  // Given: a bound pair whose hunk navigation is about to scroll both panes.
  const base = new TestScrollContainer(1_100, 100);
  const proposal = new TestScrollContainer(1_100, 100);
  const binding = bindNativeScrollContainers(base, proposal);
  const candidate: unknown = binding;
  assert.ok(isSuspendableScrollBinding(candidate));

  // When: synchronization is paused and the base receives a navigation scroll.
  candidate.suspendUntilScrollIdle();
  base.scrollFromUser(600);

  // Then: the proposal retains its independently focused hunk position.
  assert.equal(proposal.scrollTop, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  base.scrollFromUser(700);
  assert.equal(proposal.scrollTop, 700);
  binding.destroy();
});

interface SuspendableScrollBinding {
  suspendUntilScrollIdle(): void;
}

function isSuspendableScrollBinding(
  candidate: unknown,
): candidate is SuspendableScrollBinding {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof Reflect.get(candidate, "suspendUntilScrollIdle") === "function"
  );
}
