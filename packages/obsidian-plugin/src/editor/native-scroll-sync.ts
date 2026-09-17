import type { NativeScrollAnchorPair } from "./native-visual-alignment";

const SCROLL_DIFFERENCE_THRESHOLD = 1;
const SCROLL_IDLE_DELAY_MS = 250;
/**
 * A scroll event that arrives within this window after the sync wrote to that
 * pane is treated as the echo of our own write. CodeMirror virtualizes long
 * documents, so the echoed offset can be clamped or quantized to a different
 * value than the one written; comparing values alone therefore missed echoes and
 * let the two panes push each other around, which looked like the view jumping
 * back to the top or snapping to the bottom on a full-page diff.
 */
const SCROLL_ECHO_WINDOW_MS = 200;

interface PendingScrollWrite {
  /** Whether a recent programmatic write to this pane is still echoing. */
  echoing: boolean;
  /** Timer that clears the echo window. */
  timer: ReturnType<typeof setTimeout> | null;
}

export interface NativeScrollContainer {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  scrollTop: number;
  addEventListener(
    type: "scroll",
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ): void;
  removeEventListener(
    type: "scroll",
    listener: EventListener,
    options?: EventListenerOptions | boolean,
  ): void;
}

export interface NativeScrollBinding {
  suspendUntilScrollIdle(): void;
  destroy(): void;
}

export interface NativeScrollBindingOptions {
  readonly anchors?: () => readonly NativeScrollAnchorPair[];
}

export function bindNativeScrollContainers(
  base: NativeScrollContainer,
  proposal: NativeScrollContainer,
  options: NativeScrollBindingOptions = {},
): NativeScrollBinding {
  const pendingWrites = new WeakMap<NativeScrollContainer, PendingScrollWrite>();
  let active = true;
  let suspended = false;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  const resumeAfterIdle = (): void => {
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      suspended = false;
    }, SCROLL_IDLE_DELAY_MS);
  };
  const sync = (
    source: NativeScrollContainer,
    target: NativeScrollContainer,
    sourceSide: "base" | "proposal",
  ): void => {
    if (!active) return;
    if (suspended) {
      resumeAfterIdle();
      return;
    }
    const pending = pendingWrites.get(source);
    // Swallow the echo of our own write. The offset is not compared, because a
    // virtualized pane can clamp or quantize it to a different value; forwarding
    // such an echo made the two panes fight and the view jump to the top or the
    // bottom on a full-page diff.
    if (pending?.echoing === true) return;
    syncScrollProgress(source, target, sourceSide, options.anchors?.() ?? [], (scrollTop) => {
      // Clamp to the target's own range first, so the value is known before the
      // assignment. A write beyond the range would otherwise be clamped by the
      // browser, and the echoed offset could not be recognized as our own.
      const targetRange = Math.max(0, target.scrollHeight - target.clientHeight);
      const clamped = Math.min(targetRange, Math.max(0, scrollTop));
      markEchoing(target);
      target.scrollTop = clamped;
    });
  };
  const markEchoing = (target: NativeScrollContainer): void => {
    const previous = pendingWrites.get(target);
    if (previous?.timer != null) clearTimeout(previous.timer);
    const pending: PendingScrollWrite = { echoing: true, timer: null };
    pending.timer = setTimeout(() => {
      pending.echoing = false;
      pending.timer = null;
    }, SCROLL_ECHO_WINDOW_MS);
    pendingWrites.set(target, pending);
  };
  const syncProposal = (): void => sync(base, proposal, "base");
  const syncBase = (): void => sync(proposal, base, "proposal");
  base.addEventListener("scroll", syncProposal, { passive: true });
  proposal.addEventListener("scroll", syncBase, { passive: true });
  return {
    suspendUntilScrollIdle: () => {
      if (!active) return;
      suspended = true;
      pendingWrites.delete(base);
      pendingWrites.delete(proposal);
      resumeAfterIdle();
    },
    destroy: () => {
      if (!active) return;
      active = false;
      suspended = false;
      if (resumeTimer !== null) clearTimeout(resumeTimer);
      resumeTimer = null;
      pendingWrites.delete(base);
      pendingWrites.delete(proposal);
      base.removeEventListener("scroll", syncProposal);
      proposal.removeEventListener("scroll", syncBase);
    },
  };
}

export function isNativeScrollContainer(
  candidate: unknown,
): candidate is NativeScrollContainer {
  if (candidate === null || typeof candidate !== "object") return false;
  return (
    typeof Reflect.get(candidate, "clientHeight") === "number" &&
    typeof Reflect.get(candidate, "scrollHeight") === "number" &&
    typeof Reflect.get(candidate, "scrollTop") === "number" &&
    typeof Reflect.get(candidate, "addEventListener") === "function" &&
    typeof Reflect.get(candidate, "removeEventListener") === "function"
  );
}

function syncScrollProgress(
  source: NativeScrollContainer,
  target: NativeScrollContainer,
  sourceSide: "base" | "proposal",
  anchors: readonly NativeScrollAnchorPair[],
  writeTarget: (scrollTop: number) => void,
): void {
  const sourceRange = source.scrollHeight - source.clientHeight;
  const targetRange = target.scrollHeight - target.clientHeight;
  if (sourceRange <= 0 || targetRange <= 0) return;
  const targetScrollTop = mapScrollTop(
    source.scrollTop,
    sourceRange,
    targetRange,
    sourceSide,
    anchors,
  );
  if (Math.abs(target.scrollTop - targetScrollTop) <= SCROLL_DIFFERENCE_THRESHOLD) return;
  writeTarget(targetScrollTop);
}

function mapScrollTop(
  scrollTop: number,
  sourceRange: number,
  targetRange: number,
  sourceSide: "base" | "proposal",
  anchors: readonly NativeScrollAnchorPair[],
): number {
  if (anchors.length === 0) {
    const progress = Math.min(1, Math.max(0, scrollTop / sourceRange));
    return progress * targetRange;
  }
  const points = [
    { source: 0, target: 0 },
    ...anchors
      .map((anchor) => ({
        source: sourceSide === "base" ? anchor.base : anchor.proposal,
        target: sourceSide === "base" ? anchor.proposal : anchor.base,
      }))
      .filter(
        (point) =>
          point.source > 0 &&
          point.source < sourceRange &&
          point.target > 0 &&
          point.target < targetRange,
      ),
    { source: sourceRange, target: targetRange },
  ].sort((left, right) => left.source - right.source);
  const position = Math.min(sourceRange, Math.max(0, scrollTop));
  let previous = points[0] ?? { source: 0, target: 0 };
  for (const next of points.slice(1)) {
    if (next.source <= previous.source || next.target < previous.target) continue;
    if (position <= next.source) {
      const progress = (position - previous.source) / (next.source - previous.source);
      return previous.target + progress * (next.target - previous.target);
    }
    previous = next;
  }
  return targetRange;
}
