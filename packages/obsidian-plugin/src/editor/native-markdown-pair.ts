import { ItemView, MarkdownView, type App, type WorkspaceLeaf } from "obsidian";
import type { HunkDecisionKind } from "../../../core/src/model/review";
import { JsDiffEngine } from "../../../core/src/diff/jsdiff-engine";
import { t } from "../i18n";
import { renderHunk } from "../ui/diff-renderer";
import {
  createNativeDiffPair,
  planNativeDiffBlocks,
  type NativeDiffPairController,
} from "./native-diff-decorations";
import {
  tryCreateMergeEditor,
  type MergeEditorController,
} from "./cm6-adapter";
import type {
  NativeEditorPair,
  NativeEditorPairRequest,
  NativeEditorPairUpdate,
} from "./native-editor-coordinator";
import { createMainWindowReviewLeaves } from "./native-leaf-allocation";
import {
  createNativeSaveScheduler,
  type NativeSaveScheduler,
} from "./native-save-scheduler";
import { isNativeViewMounted } from "./native-view-lifecycle";

class ReviewMarkdownView extends MarkdownView {
  /**
   * Delay before a pending edit is written. Long enough that continuous typing
   * and IME composition never trigger a write mid-input, short enough that the
   * review catches up on its own like a normal Obsidian file.
   */
  private static readonly saveDebounceMs = 2000;

  private dirty = false;
  private saveScheduler: NativeSaveScheduler | null = null;

  /**
   * Obsidian calls requestSave on every document update, including each
   * intermediate state of an IME composition. Persisting synchronously here
   * wrote the review on every keystroke, which made typing sluggish and could
   * drop an in-progress composition, so the write is deferred until typing
   * pauses, matching how Obsidian saves its own files.
   */
  public override requestSave = (): void => {
    const scheduler = this.scheduler();
    if (scheduler === null) return;
    this.markDirty();
    scheduler.schedule();
  };

  private markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.leaf.updateHeader();
  }

  private scheduler(): NativeSaveScheduler | null {
    if (this.onSaveRequested === null) return null;
    this.saveScheduler ??= createNativeSaveScheduler({
      delayMs: ReviewMarkdownView.saveDebounceMs,
      persist: () => this.persist(),
    });
    return this.saveScheduler;
  }

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly title: string,
    private readonly onClosed: () => void,
    private readonly onSaveRequested: (() => Promise<void>) | null,
  ) {
    super(leaf);
    this.allowNoFile = true;
  }

  public override getDisplayText(): string {
    return this.dirty ? `${this.title} · ${t("proposalUnsaved")}` : this.title;
  }

  /** Obsidian save requests are debounced; the proposal toolbar flushes directly. */
  public override save(): Promise<void> {
    // Obsidian may call save() directly for editor updates instead of routing
    // them through requestSave(). Keep that path debounced too; the explicit
    // proposal toolbar still calls persist() and flushes immediately.
    const scheduler = this.scheduler();
    if (scheduler === null) return Promise.resolve();
    this.markDirty();
    scheduler.schedule();
    return Promise.resolve();
  }

  public async persist(): Promise<void> {
    if (this.onSaveRequested === null) return;
    this.saveScheduler?.cancel();
    await this.onSaveRequested();
    // A later keystroke may have arrived while the write was in flight; keep the
    // unsaved marker in that case, because its own deferred write is still due.
    if (this.saveScheduler?.hasPending() !== true) this.markSaved();
  }

  public markSaved(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.leaf.updateHeader();
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  public override async onClose(): Promise<void> {
    // Never drop an unsaved edit when the pane closes.
    this.saveScheduler?.cancel();
    if (this.dirty) await this.persist();
    this.onClosed();
    await super.onClose();
  }
}

export async function createNativeMarkdownPair(
  app: App,
  request: NativeEditorPairRequest,
): Promise<NativeEditorPair> {
  if (request.mode === "unified") {
    return createNativeUnifiedReview(app, request);
  }
  return createNativeSplitReview(app, request);
}

async function createNativeSplitReview(
  app: App,
  request: NativeEditorPairRequest,
): Promise<NativeEditorPair> {
  const reviewLeaves = createMainWindowReviewLeaves(app.workspace);
  const { baseLeaf, proposalLeaf } = reviewLeaves;
  let closePair = (): void => undefined;
  let saveFromCommand = async (): Promise<void> => undefined;
  const baseView = new ReviewMarkdownView(
    baseLeaf,
    `${t("currentBase")} · ${request.target}`,
    () => closePair(),
    null,
  );
  const proposalView = new ReviewMarkdownView(
    proposalLeaf,
    `${t(request.editable ? "editableProposal" : "proposal")} · ${request.newTarget ?? request.target}`,
    () => closePair(),
    () => saveFromCommand(),
  );
  const actionElements: HTMLElement[] = [];
  let diffController: NativeDiffPairController | null = null;
  let hunkIndex = -1;
  let busy = false;

  const runCommand = async (command: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    updateBusyState(actionElements, true);
    try {
      await command();
    } finally {
      busy = false;
      updateBusyState(actionElements, false);
    }
  };
  const addProposalAction = (
    icon: string,
    title: string,
    command: () => Promise<void>,
  ): HTMLElement => {
    const action = proposalView.addAction(icon, title, () => {
      void runCommand(command);
    });
    action.classList.add("obsreview-native-proposal-action");
    action.parentElement?.classList.add("obsreview-native-proposal-toolbar");
    action.parentElement?.setAttribute("role", "toolbar");
    action.parentElement?.setAttribute("aria-label", t("editableProposal"));
    actionElements.push(action);
    return action;
  };
  let submitAcceptedAction: HTMLElement | null = null;
  const updateSubmitAcceptedAction = (): void => {
    if (submitAcceptedAction === null) return;
    const hidden = request.hasAcceptedHunks() !== true;
    submitAcceptedAction.style.display = hidden ? "none" : "";
    submitAcceptedAction.setAttribute("aria-hidden", String(hidden));
  };
  const focusRelativeHunk = (delta: number): void => {
    const hunkCount = planNativeDiffBlocks(
      request.baseContent,
      proposalView.getViewData(),
    ).length;
    if (hunkCount === 0) return;
    hunkIndex =
      hunkIndex < 0
        ? delta >= 0
          ? 0
          : hunkCount - 1
        : normalizeIndex(hunkIndex + delta, hunkCount);
    diffController?.focusHunk(hunkIndex);
  };
  const decideHunk = async (decision: HunkDecisionKind): Promise<void> => {
    const update = await request.onDecideHunk(
      proposalView.getViewData(),
      hunkIndex,
      decision,
    );
    if (update === null) return;
    applyPairUpdate(proposalView, update);
    // The decision was persisted as part of the hunk write, so the draft is no
    // longer pending.
    proposalView.markSaved();
    hunkIndex = update.hunkIndex;
    diffController?.focusHunk(hunkIndex);
    updateSubmitAcceptedAction();
  };

  const persistProposal = async (): Promise<void> => {
    await request.onSave(proposalView.getViewData());
    proposalView.markSaved();
  };

  saveFromCommand = () => runCommand(() => persistProposal());

  try {
    await baseLeaf.open(baseView);
    baseView.setViewData(request.baseContent, true);
    setReadOnly(baseView);
    baseView.containerEl.addClass("obsreview-native-base");

    await proposalLeaf.open(proposalView);
    proposalView.setViewData(request.proposalContent, true);
    proposalView.containerEl.addClass("obsreview-native-proposal");
    if (request.editable) {
      addProposalAction("layout", t("unified"), async () =>
        request.onModeChange?.("unified", proposalView.getViewData()),
      );
      addProposalAction("save", t("saveProposal"), () =>
        persistProposal(),
      );
      addProposalAction("arrow-up", t("previousHunk"), async () =>
        focusRelativeHunk(-1),
      );
      addProposalAction("arrow-down", t("nextHunk"), async () =>
        focusRelativeHunk(1),
      );
      addProposalAction("check", t("acceptHunk"), () => decideHunk("accepted"));
      addProposalAction("x", t("rejectHunk"), () => decideHunk("rejected"));
      submitAcceptedAction = addProposalAction(
        "check-circle-2",
        t("submitAcceptedBlocks"),
        async () => {
          const submitted = await request.onSubmitAccepted(proposalView.getViewData());
          if (submitted) closePair();
        },
      );
      addProposalAction("file-check-2", t("approveReview"), async () => {
        const approved = await request.onApprove(proposalView.getViewData());
        if (approved) closePair();
      });
      updateSubmitAcceptedAction();
    } else {
      setReadOnly(proposalView);
    }
    diffController = await createNativeDiffPair(
      baseView,
      proposalView,
      { base: request.baseContent, proposal: request.proposalContent },
    );
    baseLeaf.updateHeader();
    proposalLeaf.updateHeader();
  } catch (error) {
    diffController?.destroy();
    await reviewLeaves.release(true, true);
    throw error;
  }

  let closed = false;
  closePair = (): void => {
    if (closed) return;
    closed = true;
    diffController?.destroy();
    const baseOwned = isNativeViewMounted(baseView.containerEl);
    const proposalOwned = isNativeViewMounted(proposalView.containerEl);
    void reviewLeaves.release(baseOwned, proposalOwned);
    request.onClose();
  };
  return {
    isOpen: () =>
      !closed &&
      isNativeViewMounted(baseView.containerEl) &&
      isNativeViewMounted(proposalView.containerEl),
    isDirty: () => proposalView.isDirty(),
    reveal: async () => {
      await app.workspace.revealLeaf(baseLeaf);
      await app.workspace.revealLeaf(proposalLeaf);
    },
    focusHunk: (index) => {
      hunkIndex = index;
      diffController?.focusHunk(index);
    },
    close: closePair,
  };
}

class ReviewUnifiedView extends ItemView {
  /** Keep single-page editing consistent with the split Markdown proposal. */
  private static readonly saveDebounceMs = 2000;

  private proposalContent: string;
  private diffHost: HTMLElement | null = null;
  private editorController: MergeEditorController | null = null;
  private dirty = false;
  private activeHunkIndex = -1;
  private readonly saveScheduler: NativeSaveScheduler;

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly title: string,
    private readonly request: NativeEditorPairRequest,
    private readonly onClosed: () => void,
  ) {
    super(leaf);
    this.proposalContent = request.proposalContent;
    this.saveScheduler = createNativeSaveScheduler({
      delayMs: ReviewUnifiedView.saveDebounceMs,
      persist: () => this.persist(),
    });
  }

  public override getViewType(): string {
    return "obsidian-review-gate-unified";
  }

  public override getDisplayText(): string {
    return this.dirty ? `${this.title} · ${t("proposalUnsaved")}` : this.title;
  }

  public override async onOpen(): Promise<void> {
    this.containerEl.addClass("obsreview-native-unified");
    if (this.request.editable) {
      this.addAction("layout", t("split"), () =>
        void this.request.onModeChange?.("split", this.getProposal()),
      );
      this.addAction("save", t("saveProposal"), () => void this.persist());
    }
    this.render();
  }

  public override async onClose(): Promise<void> {
    this.saveScheduler.cancel();
    if (this.dirty) await this.persist();
    this.editorController?.destroy();
    this.editorController = null;
    this.onClosed();
    await super.onClose();
  }

  public focusHunk(index: number): void {
    const hunks = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".obsreview-hunk"));
    if (hunks.length === 0) return;
    this.activeHunkIndex = normalizeIndex(index, hunks.length);
    hunks.forEach((hunk, hunkIndex) => {
      hunk.toggleClass("is-active", hunkIndex === this.activeHunkIndex);
    });
    hunks[this.activeHunkIndex]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  private render(): void {
    this.contentEl.empty();
    this.editorController?.destroy();
    this.editorController = null;
    const root = this.contentEl.createDiv({ cls: "obsreview-native-unified-content" });
    const summary = root.createDiv({ cls: "obsreview-diff-summary" });
    summary.createEl("code", { text: this.request.target });
    if (this.request.newTarget !== undefined) {
      summary.createSpan({ text: `→ ${this.request.newTarget}` });
    }

    const diff = new JsDiffEngine().diff(
      this.request.baseContent,
      this.proposalContent,
      { contextLines: 0 },
    );
    summary.createSpan({
      text: t(diff.stats.hunkCount === 1 ? "diffSummaryOne" : "diffSummaryMany", {
        added: diff.stats.addedLines,
        removed: diff.stats.removedLines,
        count: diff.stats.hunkCount,
      }),
    });
    this.diffHost = root.createDiv({ cls: "obsreview-native-unified-diff" });
    this.renderDiff();

    const editorHost = root.createDiv({ cls: "obsreview-native-unified-editor" });
    this.editorController = tryCreateMergeEditor(
      editorHost,
      this.request.baseContent,
      this.proposalContent,
      "unified",
      (proposal) => {
        this.proposalContent = proposal;
        this.markDirty();
        this.saveScheduler.schedule();
        this.renderDiff();
      },
    );
    if (this.editorController === null) {
      const textarea = editorHost.createEl("textarea", { cls: "obsreview-proposal-textarea" });
      textarea.value = this.proposalContent;
      textarea.addEventListener("input", () => {
        this.proposalContent = textarea.value;
        this.markDirty();
        this.saveScheduler.schedule();
        this.renderDiff();
      });
    }
  }

  private renderDiff(): void {
    if (this.diffHost === null) return;
    this.diffHost.empty();
    const diff = new JsDiffEngine().diff(
      this.request.baseContent,
      this.proposalContent,
      { contextLines: 0 },
    );
    const summary = this.diffHost.createDiv({ cls: "obsreview-diff-summary" });
    summary.createSpan({
      text: t(diff.stats.hunkCount === 1 ? "diffSummaryOne" : "diffSummaryMany", {
        added: diff.stats.addedLines,
        removed: diff.stats.removedLines,
        count: diff.stats.hunkCount,
      }),
    });
    const hunks = this.diffHost.createDiv({ cls: "obsreview-hunks" });
    if (diff.hunks.length === 0) {
      hunks.createEl("p", { cls: "obsreview-empty", text: t("proposalMatchesBase") });
      return;
    }
    for (const [index, hunk] of diff.hunks.entries()) {
      renderHunk({
        parent: hunks,
        hunk,
        mode: "unified",
        callbacks: { active: index === this.activeHunkIndex, readOnly: true },
      });
    }
  }

  private getProposal(): string {
    return this.editorController?.getProposal() ?? this.proposalContent;
  }

  private async persist(): Promise<void> {
    this.proposalContent = this.getProposal();
    await this.request.onSave(this.proposalContent);
    if (this.saveScheduler.hasPending() !== true) this.markSaved();
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.leaf.updateHeader();
    }
  }

  private markSaved(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.leaf.updateHeader();
  }
}

async function createNativeUnifiedReview(
  app: App,
  request: NativeEditorPairRequest,
): Promise<NativeEditorPair> {
  const leaf = app.workspace.getLeaf("tab");
  let closePair = (): void => undefined;
  const view = new ReviewUnifiedView(
    leaf,
    `${t(request.editable ? "editableProposal" : "proposal")} · ${request.newTarget ?? request.target}`,
    request,
    () => closePair(),
  );
  try {
    await leaf.open(view);
    leaf.updateHeader();
  } catch (error) {
    leaf.detach();
    throw error;
  }

  let closed = false;
  closePair = (): void => {
    if (closed) return;
    closed = true;
    if (isNativeViewMounted(view.containerEl)) leaf.detach();
    request.onClose();
  };
  return {
    isOpen: () => !closed && isNativeViewMounted(view.containerEl),
    isDirty: () => view.isDirty(),
    reveal: async () => {
      await app.workspace.revealLeaf(leaf);
    },
    focusHunk: (index) => view.focusHunk(index),
    close: closePair,
  };
}

function applyPairUpdate(
  proposalView: MarkdownView,
  update: NativeEditorPairUpdate,
): void {
  if (proposalView.getViewData() !== update.proposalContent) {
    proposalView.editor.setValue(update.proposalContent);
  }
}

function setReadOnly(view: MarkdownView): void {
  const lockContent = (): void => {
    view.containerEl.querySelectorAll<HTMLElement>(".cm-content").forEach((content) => {
      content.contentEditable = "false";
      content.setAttribute("aria-readonly", "true");
    });
  };
  const preventInput = (event: Event): void => event.preventDefault();
  lockContent();
  const observer = new MutationObserver(lockContent);
  observer.observe(view.containerEl, { childList: true, subtree: true });
  view.containerEl.addEventListener("beforeinput", preventInput, true);
  view.register(() => {
    observer.disconnect();
    view.containerEl.removeEventListener("beforeinput", preventInput, true);
  });
}

function updateBusyState(actions: readonly HTMLElement[], busy: boolean): void {
  for (const action of actions) {
    action.toggleClass("is-disabled", busy);
    action.setAttribute("aria-disabled", String(busy));
  }
}

function normalizeIndex(index: number, length: number): number {
  return length === 0 ? 0 : ((index % length) + length) % length;
}
