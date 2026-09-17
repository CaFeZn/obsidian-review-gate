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
import { isNativeViewMounted } from "./native-view-lifecycle";

class ReviewMarkdownView extends MarkdownView {
  public override requestSave = (): void => {
    void this.onSaveRequested?.();
  };

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
    return this.title;
  }

  public override save(): Promise<void> {
    // Obsidian's editor:save-file command (Ctrl+S) calls view.save(), so a
    // no-op here made Ctrl+S silently do nothing on the editable proposal.
    return this.onSaveRequested?.() ?? Promise.resolve();
  }

  public override async onClose(): Promise<void> {
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
  let hunkIndex = 0;
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
  ): void => {
    const action = proposalView.addAction(icon, title, () => {
      void runCommand(command);
    });
    action.classList.add("obsreview-native-proposal-action");
    action.parentElement?.classList.add("obsreview-native-proposal-toolbar");
    action.parentElement?.setAttribute("role", "toolbar");
    action.parentElement?.setAttribute("aria-label", t("editableProposal"));
    actionElements.push(action);
  };
  const focusRelativeHunk = (delta: number): void => {
    const hunkCount = planNativeDiffBlocks(
      request.baseContent,
      proposalView.getViewData(),
    ).length;
    if (hunkCount === 0) return;
    hunkIndex = normalizeIndex(hunkIndex + delta, hunkCount);
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
    hunkIndex = update.hunkIndex;
    diffController?.focusHunk(hunkIndex);
  };

  saveFromCommand = () => runCommand(() => request.onSave(proposalView.getViewData()));

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
        request.onSave(proposalView.getViewData()),
      );
      addProposalAction("arrow-up", t("previousHunk"), async () =>
        focusRelativeHunk(-1),
      );
      addProposalAction("arrow-down", t("nextHunk"), async () =>
        focusRelativeHunk(1),
      );
      addProposalAction("check", t("acceptHunk"), () => decideHunk("accepted"));
      addProposalAction("x", t("rejectHunk"), () => decideHunk("rejected"));
      addProposalAction("file-check-2", t("approveReview"), async () => {
        const approved = await request.onApprove(proposalView.getViewData());
        if (approved) closePair();
      });
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
  private proposalContent: string;
  private diffHost: HTMLElement | null = null;
  private editorController: MergeEditorController | null = null;

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly title: string,
    private readonly request: NativeEditorPairRequest,
    private readonly onClosed: () => void,
  ) {
    super(leaf);
    this.proposalContent = request.proposalContent;
  }

  public override getViewType(): string {
    return "obsidian-review-gate-unified";
  }

  public override getDisplayText(): string {
    return this.title;
  }

  public override async onOpen(): Promise<void> {
    this.containerEl.addClass("obsreview-native-unified");
    if (this.request.editable) {
      this.addAction("layout", t("split"), () =>
        void this.request.onModeChange?.("split", this.getProposal()),
      );
      this.addAction("save", t("saveProposal"), () => void this.save());
    }
    this.render();
  }

  public override async onClose(): Promise<void> {
    this.editorController?.destroy();
    this.editorController = null;
    this.onClosed();
    await super.onClose();
  }

  public focusHunk(index: number): void {
    const hunks = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".obsreview-hunk"));
    if (hunks.length === 0) return;
    hunks[normalizeIndex(index, hunks.length)]?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
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

    const diff = new JsDiffEngine().diff(this.request.baseContent, this.proposalContent);
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
        this.renderDiff();
      },
    );
    if (this.editorController === null) {
      const textarea = editorHost.createEl("textarea", { cls: "obsreview-proposal-textarea" });
      textarea.value = this.proposalContent;
      textarea.addEventListener("input", () => {
        this.proposalContent = textarea.value;
        this.renderDiff();
      });
    }
  }

  private renderDiff(): void {
    if (this.diffHost === null) return;
    this.diffHost.empty();
    const diff = new JsDiffEngine().diff(this.request.baseContent, this.proposalContent);
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
    for (const hunk of diff.hunks) {
      renderHunk({ parent: hunks, hunk, mode: "unified", callbacks: { readOnly: true } });
    }
  }

  private getProposal(): string {
    return this.editorController?.getProposal() ?? this.proposalContent;
  }

  private async save(): Promise<void> {
    this.proposalContent = this.getProposal();
    await this.request.onSave(this.proposalContent);
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
