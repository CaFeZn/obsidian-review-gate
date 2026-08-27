export interface NativeVisualAlignmentRow {
  readonly key: string;
  readonly top: number;
  readonly bottom: number;
}

export interface NativeScrollAnchorPair {
  readonly base: number;
  readonly proposal: number;
}

export interface NativePixelAlignmentPlan {
  readonly baseBeforePixels: Readonly<Record<string, number>>;
  readonly proposalBeforePixels: Readonly<Record<string, number>>;
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
  readonly createStyleSheet?: (
    side: "base" | "proposal",
    surface: NativeVisualAlignmentSurface,
  ) => NativeVisualAlignmentStyleSheet;
}

export interface NativeVisualAlignmentStyleSheet {
  update(
    before: Readonly<Record<string, number>>,
    after: Readonly<Record<string, number>>,
  ): void;
  destroy(): void;
}

interface NativeVisualAlignmentElement {
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): string;
  };
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { readonly top: number; readonly bottom: number };
}

const ALIGNMENT_SELECTOR = "[data-obsreview-align-key]";
const ALIGNMENT_KEY_ATTRIBUTE = "data-obsreview-align-key";
const ALIGNMENT_BEFORE_PROPERTY = "--obsreview-alignment-before";
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
  const createStyleSheet = options.createStyleSheet ?? defaultAlignmentStyleSheet;
  const baseStyleSheet = createStyleSheet("base", base);
  const proposalStyleSheet = createStyleSheet("proposal", proposal);
  let active = true;
  let frame: number | null = null;
  let anchors: readonly NativeScrollAnchorPair[] = [];
  let resizeTargets = new Set<object>();

  const measure = (): void => {
    if (!active) return;
    const baseElements = alignmentElements(base);
    const proposalElements = alignmentElements(proposal);
    baseStyleSheet.update({}, {});
    proposalStyleSheet.update({}, {});
    clearAlignmentExtras(baseElements);
    clearAlignmentExtras(proposalElements);
    const baseRows = measureAlignmentRows(base, baseElements);
    const proposalRows = measureAlignmentRows(proposal, proposalElements);
    const plan = planNativePixelAlignment(baseRows, proposalRows);
    applyAlignmentExtras(baseElements, plan.baseBeforePixels, ALIGNMENT_BEFORE_PROPERTY);
    applyAlignmentExtras(
      proposalElements,
      plan.proposalBeforePixels,
      ALIGNMENT_BEFORE_PROPERTY,
    );
    applyAlignmentExtras(baseElements, plan.baseExtraPixels, ALIGNMENT_EXTRA_PROPERTY);
    applyAlignmentExtras(
      proposalElements,
      plan.proposalExtraPixels,
      ALIGNMENT_EXTRA_PROPERTY,
    );
    baseStyleSheet.update(plan.baseBeforePixels, plan.baseExtraPixels);
    proposalStyleSheet.update(plan.proposalBeforePixels, plan.proposalExtraPixels);
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
      baseStyleSheet.destroy();
      proposalStyleSheet.destroy();
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
  const baseBeforePixels: Record<string, number> = {};
  const proposalBeforePixels: Record<string, number> = {};
  const baseExtraPixels: Record<string, number> = {};
  const proposalExtraPixels: Record<string, number> = {};
  const anchors: NativeScrollAnchorPair[] = [];
  let baseOffset = 0;
  let proposalOffset = 0;

  for (const baseRow of baseRows) {
    const proposalRow = proposalByKey.get(baseRow.key);
    if (proposalRow === undefined) continue;
    let baseTop = baseRow.top + baseOffset;
    let proposalTop = proposalRow.top + proposalOffset;
    if (baseTop < proposalTop) {
      const extra = proposalTop - baseTop;
      baseBeforePixels[baseRow.key] = extra;
      baseOffset += extra;
    } else if (proposalTop < baseTop) {
      const extra = baseTop - proposalTop;
      proposalBeforePixels[proposalRow.key] = extra;
      proposalOffset += extra;
    }
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

  return {
    baseBeforePixels,
    proposalBeforePixels,
    baseExtraPixels,
    proposalExtraPixels,
    anchors,
  };
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
  const seen = new Set<string>();
  const rows: NativeVisualAlignmentRow[] = [];
  for (const element of elements) {
    const key = element.getAttribute(ALIGNMENT_KEY_ATTRIBUTE);
    if (key === null || seen.has(key)) continue;
    const rectangle = element.getBoundingClientRect();
    const rowTop = rectangle.top + surface.scrollTop;
    const bottom = rectangle.bottom + surface.scrollTop;
    if (!Number.isFinite(rowTop) || !Number.isFinite(bottom)) continue;
    seen.add(key);
    rows.push({ key, top: rowTop, bottom });
  }
  return rows;
}

function clearAlignmentExtras(elements: readonly NativeVisualAlignmentElement[]): void {
  for (const element of elements) {
    element.style.removeProperty(ALIGNMENT_BEFORE_PROPERTY);
    element.style.removeProperty(ALIGNMENT_EXTRA_PROPERTY);
  }
}

function applyAlignmentExtras(
  elements: readonly NativeVisualAlignmentElement[],
  extras: Readonly<Record<string, number>>,
  property: string,
): void {
  const elementsByKey = new Map(
    elements.map((element) => [element.getAttribute(ALIGNMENT_KEY_ATTRIBUTE), element]),
  );
  for (const [key, extra] of Object.entries(extras)) {
    if (extra <= 0) continue;
    elementsByKey.get(key)?.style.setProperty(property, `${extra}px`);
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

function defaultAlignmentStyleSheet(
  side: "base" | "proposal",
  surface: NativeVisualAlignmentSurface,
): NativeVisualAlignmentStyleSheet {
  const ownerDocument: unknown = Reflect.get(surface, "ownerDocument");
  if (
    ownerDocument === null ||
    typeof ownerDocument !== "object" ||
    typeof Reflect.get(ownerDocument, "createElement") !== "function"
  ) {
    return { update: () => undefined, destroy: () => undefined };
  }
  const style = (ownerDocument as Document).createElement("style");
  (ownerDocument as Document).head.appendChild(style);
  const scope = side === "base" ? ".obsreview-native-base" : ".obsreview-native-proposal";
  return {
    update: (before, after) => {
      style.textContent = alignmentStyleRules(scope, before, after);
    },
    destroy: () => style.remove(),
  };
}

function alignmentStyleRules(
  scope: string,
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): string {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const rules: string[] = [];
  for (const key of keys) {
    const declarations: string[] = [];
    const beforePixels = before[key];
    const afterPixels = after[key];
    if (beforePixels !== undefined && beforePixels > 0) {
      declarations.push(`${ALIGNMENT_BEFORE_PROPERTY}: ${beforePixels}px`);
    }
    if (afterPixels !== undefined && afterPixels > 0) {
      declarations.push(`${ALIGNMENT_EXTRA_PROPERTY}: ${afterPixels}px`);
    }
    if (declarations.length === 0) continue;
    rules.push(
      `${scope} .cm-line[${ALIGNMENT_KEY_ATTRIBUTE}="${escapeCssAttribute(key)}"] { ${declarations.join("; ")} }`,
    );
  }
  return rules.join("\n");
}

function escapeCssAttribute(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}
