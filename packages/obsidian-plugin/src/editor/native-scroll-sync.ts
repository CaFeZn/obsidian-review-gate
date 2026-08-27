import type { NativeScrollAnchorPair } from "./native-visual-alignment";

const SCROLL_DIFFERENCE_THRESHOLD = 1;
const SCROLL_IDLE_DELAY_MS = 250;

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
  const pendingWrites = new WeakMap<NativeScrollContainer, number>();
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
    const expectedScrollTop = pendingWrites.get(source);
    pendingWrites.delete(source);
    if (
      expectedScrollTop !== undefined &&
      Math.abs(source.scrollTop - expectedScrollTop) <= SCROLL_DIFFERENCE_THRESHOLD
    ) {
      return;
    }
    syncScrollProgress(source, target, sourceSide, options.anchors?.() ?? [], (scrollTop) => {
      pendingWrites.set(target, scrollTop);
      target.scrollTop = scrollTop;
    });
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
    ...anchors.map((anchor) => ({
      source: sourceSide === "base" ? anchor.base : anchor.proposal,
      target: sourceSide === "base" ? anchor.proposal : anchor.base,
    })).filter(
      (point) =>
        point.source > 0 &&
        point.source < sourceRange &&
        point.target > 0 &&
        point.target < targetRange,
    ),
    { source: sourceRange, target: targetRange },
  ]
    .sort((left, right) => left.source - right.source);
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
