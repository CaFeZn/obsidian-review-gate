export interface NativeVisualAlignmentRow {
  readonly key: string;
  readonly bottom: number;
}

export interface NativeScrollAnchorPair {
  readonly base: number;
  readonly proposal: number;
}

export interface NativePixelAlignmentPlan {
  readonly baseExtraPixels: Readonly<Record<string, number>>;
  readonly proposalExtraPixels: Readonly<Record<string, number>>;
  readonly anchors: readonly NativeScrollAnchorPair[];
}

export interface NativeVisualAlignmentSurface {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
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
  getBoundingClientRect(): { readonly top: number };
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

export interface NativeVisualAlignmentObserver {
  observe(target: unknown): void;
  unobserve?(target: unknown): void;
  disconnect(): void;
}

export interface NativeVisualAlignmentBinding {
  anchors(): readonly NativeScrollAnchorPair[];
  destroy(): void;
}

export interface NativeVisualAlignmentBindingOptions {
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly createResizeObserver?: (
    callback: () => void,
  ) => NativeVisualAlignmentObserver;
  readonly createMutationObserver?: (
    callback: () => void,
  ) => NativeVisualAlignmentObserver;
}

interface NativeVisualAlignmentElement {
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): string;
  };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly bottom: number };
}

const ALIGNMENT_SELECTOR = "[data-obsreview-align-key]";
const ALIGNMENT_KEY_ATTRIBUTE = "data-obsreview-align-key";
const ALIGNMENT_EXTRA_PROPERTY = "--obsreview-alignment-extra";

export function bindNativeVisualAlignment(
  base: NativeVisualAlignmentSurface,
  proposal: NativeVisualAlignmentSurface,
  options: NativeVisualAlignmentBindingOptions = {},
): NativeVisualAlignmentBinding {
  const requestFrame =
    options.requestFrame ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const createResizeObserver = options.createResizeObserver ?? defaultResizeObserver;
  const createMutationObserver = options.createMutationObserver ?? defaultMutationObserver;
  let active = true;
  let frame: number | null = null;
  let anchors: readonly NativeScrollAnchorPair[] = [];
  let resizeTargets = new Set<object>();

  const measure = (): void => {
    if (!active) return;
    const baseElements = alignmentElements(base);
    const proposalElements = alignmentElements(proposal);
    clearAlignmentExtras(baseElements);
    clearAlignmentExtras(proposalElements);
    const baseRows = measureAlignmentRows(base, baseElements);
    const proposalRows = measureAlignmentRows(proposal, proposalElements);
    const plan = planNativePixelAlignment(baseRows, proposalRows);
    applyAlignmentExtras(baseElements, plan.baseExtraPixels);
    applyAlignmentExtras(proposalElements, plan.proposalExtraPixels);
    anchors = plan.anchors;
    const nextResizeTargets = new Set<object>([
      base,
      proposal,
      ...baseElements,
      ...proposalElements,
    ]);
    for (const target of resizeTargets) {
      if (!nextResizeTargets.has(target)) resizeObserver.unobserve?.(target);
    }
    for (const target of nextResizeTargets) {
      if (!resizeTargets.has(target)) resizeObserver.observe(target);
    }
    resizeTargets = nextResizeTargets;
  };
  const schedule = (): void => {
    if (!active || frame !== null) return;
    frame = requestFrame(() => {
      frame = null;
      measure();
    });
  };
  const resizeObserver = createResizeObserver(schedule);
  const mutationObserver = createMutationObserver(schedule);
  const onScroll: EventListener = () => schedule();
  mutationObserver.observe(base);
  mutationObserver.observe(proposal);
  base.addEventListener("scroll", onScroll, { passive: true });
  proposal.addEventListener("scroll", onScroll, { passive: true });
  measure();
  schedule();

  return {
    anchors: () => anchors,
    destroy: () => {
      if (!active) return;
      active = false;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      resizeObserver.disconnect();
      resizeTargets.clear();
      mutationObserver.disconnect();
      base.removeEventListener("scroll", onScroll);
      proposal.removeEventListener("scroll", onScroll);
      clearAlignmentExtras(alignmentElements(base));
      clearAlignmentExtras(alignmentElements(proposal));
      anchors = [];
    },
  };
}

export function isNativeVisualAlignmentSurface(
  candidate: unknown,
): candidate is NativeVisualAlignmentSurface {
  if (candidate === null || typeof candidate !== "object") return false;
  return (
    typeof Reflect.get(candidate, "clientHeight") === "number" &&
    typeof Reflect.get(candidate, "scrollHeight") === "number" &&
    typeof Reflect.get(candidate, "scrollTop") === "number" &&
    typeof Reflect.get(candidate, "addEventListener") === "function" &&
    typeof Reflect.get(candidate, "removeEventListener") === "function" &&
    typeof Reflect.get(candidate, "getBoundingClientRect") === "function" &&
    typeof Reflect.get(candidate, "querySelectorAll") === "function"
  );
}

export function planNativePixelAlignment(
  baseRows: readonly NativeVisualAlignmentRow[],
  proposalRows: readonly NativeVisualAlignmentRow[],
): NativePixelAlignmentPlan {
  const proposalByKey = new Map(proposalRows.map((row) => [row.key, row]));
  const baseExtraPixels: Record<string, number> = {};
  const proposalExtraPixels: Record<string, number> = {};
  const anchors: NativeScrollAnchorPair[] = [];
  let baseOffset = 0;
  let proposalOffset = 0;

  for (const baseRow of baseRows) {
    const proposalRow = proposalByKey.get(baseRow.key);
    if (proposalRow === undefined) continue;
    let baseBottom = baseRow.bottom + baseOffset;
    let proposalBottom = proposalRow.bottom + proposalOffset;
    if (baseBottom < proposalBottom) {
      const extra = proposalBottom - baseBottom;
      baseExtraPixels[baseRow.key] = extra;
      baseOffset += extra;
      baseBottom += extra;
    } else if (proposalBottom < baseBottom) {
      const extra = baseBottom - proposalBottom;
      proposalExtraPixels[proposalRow.key] = extra;
      proposalOffset += extra;
      proposalBottom += extra;
    }
    anchors.push({ base: baseBottom, proposal: proposalBottom });
  }

  return { baseExtraPixels, proposalExtraPixels, anchors };
}

function alignmentElements(
  surface: NativeVisualAlignmentSurface,
): readonly NativeVisualAlignmentElement[] {
  return Array.from(surface.querySelectorAll(ALIGNMENT_SELECTOR)).filter(
    isNativeVisualAlignmentElement,
  );
}

function measureAlignmentRows(
  surface: NativeVisualAlignmentSurface,
  elements: readonly NativeVisualAlignmentElement[],
): readonly NativeVisualAlignmentRow[] {
  const top = surface.getBoundingClientRect().top;
  const seen = new Set<string>();
  const rows: NativeVisualAlignmentRow[] = [];
  for (const element of elements) {
    const key = element.getAttribute(ALIGNMENT_KEY_ATTRIBUTE);
    if (key === null || seen.has(key)) continue;
    const bottom = element.getBoundingClientRect().bottom - top + surface.scrollTop;
    if (!Number.isFinite(bottom)) continue;
    seen.add(key);
    rows.push({ key, bottom });
  }
  return rows;
}

function clearAlignmentExtras(elements: readonly NativeVisualAlignmentElement[]): void {
  for (const element of elements) element.style.removeProperty(ALIGNMENT_EXTRA_PROPERTY);
}

function applyAlignmentExtras(
  elements: readonly NativeVisualAlignmentElement[],
  extras: Readonly<Record<string, number>>,
): void {
  const elementsByKey = new Map(
    elements.map((element) => [element.getAttribute(ALIGNMENT_KEY_ATTRIBUTE), element]),
  );
  for (const [key, extra] of Object.entries(extras)) {
    if (extra <= 0) continue;
    elementsByKey.get(key)?.style.setProperty(ALIGNMENT_EXTRA_PROPERTY, `${extra}px`);
  }
}

function isNativeVisualAlignmentElement(
  candidate: unknown,
): candidate is NativeVisualAlignmentElement {
  if (candidate === null || typeof candidate !== "object") return false;
  const style: unknown = Reflect.get(candidate, "style");
  return (
    style !== null &&
    typeof style === "object" &&
    typeof Reflect.get(style, "setProperty") === "function" &&
    typeof Reflect.get(style, "removeProperty") === "function" &&
    typeof Reflect.get(candidate, "getAttribute") === "function" &&
    typeof Reflect.get(candidate, "getBoundingClientRect") === "function"
  );
}

function defaultResizeObserver(callback: () => void): NativeVisualAlignmentObserver {
  const observer = new ResizeObserver(() => callback());
  return {
    observe: (target) => observer.observe(target as Element),
    unobserve: (target) => observer.unobserve(target as Element),
    disconnect: () => observer.disconnect(),
  };
}

function defaultMutationObserver(callback: () => void): NativeVisualAlignmentObserver {
  const observer = new MutationObserver(() => callback());
  return {
    observe: (target) =>
      observer.observe(target as Node, {
        attributes: true,
        attributeFilter: [ALIGNMENT_KEY_ATTRIBUTE],
        childList: true,
        characterData: true,
        subtree: true,
      }),
    disconnect: () => observer.disconnect(),
  };
}
