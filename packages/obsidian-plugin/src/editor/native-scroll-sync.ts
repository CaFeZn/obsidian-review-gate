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

export function bindNativeScrollContainers(
  base: NativeScrollContainer,
  proposal: NativeScrollContainer,
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
    syncScrollProgress(source, target, (scrollTop) => {
      pendingWrites.set(target, scrollTop);
      target.scrollTop = scrollTop;
    });
  };
  const syncProposal = (): void => sync(base, proposal);
  const syncBase = (): void => sync(proposal, base);
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
  writeTarget: (scrollTop: number) => void,
): void {
  const sourceRange = source.scrollHeight - source.clientHeight;
  const targetRange = target.scrollHeight - target.clientHeight;
  if (sourceRange <= 0 || targetRange <= 0) return;
  const progress = Math.min(1, Math.max(0, source.scrollTop / sourceRange));
  const targetScrollTop = progress * targetRange;
  if (Math.abs(target.scrollTop - targetScrollTop) <= SCROLL_DIFFERENCE_THRESHOLD) return;
  writeTarget(targetScrollTop);
}
