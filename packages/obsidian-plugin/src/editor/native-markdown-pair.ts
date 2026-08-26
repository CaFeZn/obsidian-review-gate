import { MarkdownView, type App, type WorkspaceLeaf } from "obsidian";
import type { HunkDecisionKind } from "../../../core/src/model/review";
import { t } from "../i18n";
import {
  createNativeDiffPair,
  planNativeDiffBlocks,
  type NativeDiffPairController,
} from "./native-diff-decorations";
import type {
  NativeEditorPair,
  NativeEditorPairRequest,
  NativeEditorPairUpdate,
} from "./native-editor-coordinator";
import { createMainWindowReviewLeaves } from "./native-leaf-allocation";
import { isNativeViewMounted } from "./native-view-lifecycle";

class ReviewMarkdownView extends MarkdownView {
  public override requestSave = (): void => this.onSaveRequested?.();

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly title: string,
    private readonly onClosed: () => void,
    private readonly onSaveRequested: (() => void) | null,
  ) {
    super(leaf);
    this.allowNoFile = true;
  }

  public override getDisplayText(): string {
    return this.title;
  }

  public override save(): Promise<void> {
    return Promise.resolve();
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
  const reviewLeaves = createMainWindowReviewLeaves(app.workspace);
  const { baseLeaf, proposalLeaf } = reviewLeaves;
  let closePair = (): void => undefined;
  let saveFromCommand = (): void => undefined;
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

  saveFromCommand = () => {
    void runCommand(() => request.onSave(proposalView.getViewData()));
  };

  try {
    await baseLeaf.open(baseView);
    baseView.setViewData(request.baseContent, true);
    setReadOnly(baseView);
    baseView.containerEl.addClass("obsreview-native-base");

    await proposalLeaf.open(proposalView);
    proposalView.setViewData(request.proposalContent, true);
    proposalView.containerEl.addClass("obsreview-native-proposal");
    if (request.editable) {
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
