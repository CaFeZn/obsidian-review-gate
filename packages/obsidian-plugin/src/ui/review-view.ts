import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type { Review, ReviewChange } from "../../../core/src/model/review";
import { ReviewError } from "../../../core/src/model/errors";
import type { ReviewService } from "../../../core/src/service/review-service";
import type { DiffHunk } from "../../../core/src/diff/types";
import {
  buildFileHistory,
  filterFileHistoryPaths,
  type FileHistoryEntry,
  type FileHistoryIndex,
} from "../history/file-history";
import { t } from "../i18n";
import { renderHunk, type DiffMode } from "./diff-renderer";
import { renderCjkWrappedText } from "./cjk-wrap-renderer";
import { ConfirmActionModal, message } from "./modals";

export const REVIEW_GATE_VIEW_TYPE = "obsidian-review-gate";

type ReviewTab = "pending" | "conflicted" | "history";

export class ReviewGateView extends ItemView {
  private tab: ReviewTab = "pending";
  private selectedReviewId: string | null = null;
  private selectedChangeId: string | null = null;
  private mode: DiffMode = "split";
  private modePreference: "auto" | DiffMode = "auto";
  private nativeMode: DiffMode = "split";
  private resizeObserver: ResizeObserver | null = null;
  private hunkIndex = 0;
  private selectedHistoryPath: string | null = null;
  private historyQuery = "";
  private renderGeneration = 0;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    this.moveHunk(event.key === "ArrowDown" ? 1 : -1);
  };

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly service: ReviewService,
    private readonly openNativeEditor: (
      review: Review,
      change: ReviewChange,
      mode: DiffMode,
    ) => Promise<void>,
    private readonly focusNativeHunk: (index: number) => void,
  ) {
    super(leaf);
  }

  public getViewType(): string {
    return REVIEW_GATE_VIEW_TYPE;
  }

  public getDisplayText(): string {
    return t("reviewGate");
  }

  public override getIcon(): string {
    return "file-check-2";
  }

  public override async onOpen(): Promise<void> {
    this.contentEl.addClass("obsreview-view");
    this.contentEl.tabIndex = 0;
    this.contentEl.addEventListener("keydown", this.onKeyDown);
    // A narrow sidebar cannot fit two readable diff columns, so the review page
    // follows its own width until the reader picks a layout explicitly.
    this.resizeObserver = new ResizeObserver(() => {
      if (this.modePreference !== "auto") return;
      const nextMode = this.autoMode();
      if (nextMode === this.mode) return;
      this.mode = nextMode;
      void this.refresh();
    });
    this.resizeObserver.observe(this.contentEl);
    this.mode = this.autoMode();
    await this.refresh();
  }

  public override onClose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.contentEl.removeEventListener("keydown", this.onKeyDown);
    this.contentEl.empty();
  }

  public async showFileHistory(vaultPath: string): Promise<void> {
    this.tab = "history";
    this.selectedReviewId = null;
    this.selectedChangeId = null;
    this.selectedHistoryPath = vaultPath.replace(/\\/gu, "/");
    this.historyQuery = this.selectedHistoryPath;
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    const generation = ++this.renderGeneration;
    try {
      if (this.selectedReviewId !== null) {
        const review = await this.service.get(this.selectedReviewId);
        if (generation !== this.renderGeneration) return;
        await this.renderReview(review);
      } else {
        await this.renderList(generation);
      }
    } catch (error) {
      if (generation !== this.renderGeneration) return;
      if (error instanceof ReviewError && error.code === "REVIEW_NOT_FOUND") {
        this.selectedReviewId = null;
        await this.renderList(generation);
        return;
      }
      this.contentEl.empty();
      this.contentEl.createEl("p", {
        cls: "obsreview-error",
        text: t("reviewCouldNotLoad", { error: message(error) }),
      });
    }
  }

  private async renderList(generation: number): Promise<void> {
    const locations = this.tab === "history" ? (["history"] as const) : (["pending"] as const);
    const reviews = await this.service.list({ locations });
    if (generation !== this.renderGeneration) return;
    const filtered = reviews.filter((review) => {
      if (this.tab === "history") return isTerminal(review);
      if (this.tab === "conflicted") {
        return review.status === "conflicted" || review.conflict?.advisory === true;
      }
      return review.status === "pending" && review.conflict?.advisory !== true;
    });
    const fileHistory = this.tab === "history" ? buildFileHistory(filtered) : null;
    const historyEntries =
      fileHistory !== null && this.selectedHistoryPath !== null
        ? fileHistory.entriesFor(this.selectedHistoryPath)
        : null;
    const visibleReviews = historyEntries?.map((entry) => entry.review) ?? filtered;
    const historyEntryByReview = new Map(
      historyEntries?.map((entry) => [entry.review.id, entry] as const) ?? [],
    );

    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "obsreview-header" });
    header.createEl("h2", { text: t("reviewGate") });
    header.createSpan({ cls: "obsreview-count", text: String(visibleReviews.length) });
    const tabs = this.contentEl.createDiv({ cls: "obsreview-tabs" });
    for (const tab of ["pending", "conflicted", "history"] as const) {
      const button = tabs.createEl("button", {
        text: tabLabel(tab),
        cls: this.tab === tab ? "is-active" : "",
      });
      button.addEventListener("click", () => {
        this.tab = tab;
        this.selectedReviewId = null;
        if (tab !== "history") {
          this.selectedHistoryPath = null;
          this.historyQuery = "";
        }
        void this.refresh();
      });
    }

    if (fileHistory !== null) this.renderHistoryPicker(fileHistory);

    if (visibleReviews.length === 0) {
      this.contentEl.createEl("p", {
        cls: "obsreview-empty",
        text:
          this.tab === "history" && this.selectedHistoryPath !== null
            ? t("noFileHistory")
            : this.tab === "history"
            ? t("noCompletedReviews")
            : this.tab === "conflicted"
              ? t("noConflictedReviews")
              : t("noPendingReviews"),
      });
      return;
    }

    const list = this.contentEl.createDiv({ cls: "obsreview-list" });
    for (const review of visibleReviews) {
      const historyEntry = historyEntryByReview.get(review.id);
      const card = list.createDiv({ cls: "obsreview-card" });
      card.tabIndex = 0;
      const heading = card.createDiv({ cls: "obsreview-card-heading" });
      heading.createEl("strong", { text: `#${review.id.slice(-8)}` });
      heading.createSpan({
        cls: `obsreview-status is-${review.status}`,
        text:
          review.conflict?.advisory === true
            ? t("potentialConflict")
            : statusLabel(review.status),
      });
      this.renderCardTarget(card, review, historyEntry);
      const source = sourceLabel(review);
      card.createEl("small", {
        text: `${source} · ${t("revisionInline", { revision: review.revision })} · ${review.updatedAt}`,
      });
      const open = (): void => {
        const firstChange = historyEntry?.change ?? review.changes[0];
        this.selectedReviewId = review.id;
        this.selectedChangeId = firstChange?.id ?? null;
        this.hunkIndex = 0;
        void this.refresh();
    if (firstChange !== undefined) {
      void this.openNativeEditor(review, firstChange, this.nativeMode);
    }
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open();
      });
    }
  }

  private renderHistoryPicker(fileHistory: FileHistoryIndex): void {
    const picker = this.contentEl.createDiv({ cls: "obsreview-history-picker" });
    const heading = picker.createDiv({ cls: "obsreview-history-picker-heading" });
    heading.createEl("strong", { text: t("fileHistory") });
    addButton(
      heading,
      t("allReviews"),
      () => {
        this.selectedHistoryPath = null;
        this.historyQuery = "";
        void this.refresh();
      },
      this.selectedHistoryPath === null ? "is-active" : "",
    );
    const input = picker.createEl("input", {
      type: "search",
      attr: { placeholder: t("searchFileHistory") },
    });
    input.value = this.historyQuery;
    input.setAttribute("aria-label", t("searchFileHistory"));
    const results = picker.createDiv({ cls: "obsreview-history-paths" });
    const renderResults = (): void => {
      results.empty();
      const paths = filterFileHistoryPaths(fileHistory.paths, this.historyQuery).slice(0, 20);
      for (const path of paths) {
        const button = results.createEl("button", {
          cls: path === this.selectedHistoryPath ? "is-active" : "",
        });
        renderCjkWrappedText(button, path);
        button.addEventListener("click", () => {
          this.selectedHistoryPath = path;
          this.historyQuery = path;
          this.selectedReviewId = null;
          this.selectedChangeId = null;
          void this.refresh();
        });
      }
    };
    input.addEventListener("input", () => {
      this.historyQuery = input.value;
      renderResults();
    });
    renderResults();
  }

  private renderCardTarget(
    card: HTMLElement,
    review: Review,
    historyEntry: FileHistoryEntry | undefined,
  ): void {
    const target = card.createDiv({ cls: "obsreview-card-target" });
    if (historyEntry === undefined) {
      renderCjkWrappedText(
        target,
        review.changes.length === 1
          ? review.changes[0]?.target ?? t("unknownTarget")
          : t(review.changes.length === 1 ? "oneFile" : "manyFiles", {
              count: review.changes.length,
            }),
      );
      return;
    }
    const change = historyEntry.change;
    renderCjkWrappedText(target, `${operationLabel(change.operation)} · ${change.target}`);
    if (change.newTarget !== undefined) {
      target.append(" → ");
      renderCjkWrappedText(target, change.newTarget);
    }
  }

  private async renderReview(review: Review): Promise<void> {
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv({ cls: "obsreview-detail-toolbar" });
    addButton(toolbar, t("back"), () => {
      this.selectedReviewId = null;
      this.selectedChangeId = null;
      void this.refresh();
    });
    toolbar.createEl("h2", {
      text: t("reviewHeading", { id: review.id.slice(-8) }),
    });
    toolbar.createSpan({
      cls: `obsreview-status is-${review.status}`,
      text: statusLabel(review.status),
    });

    const metadata = this.contentEl.createDiv({ cls: "obsreview-metadata" });
    metadata.createSpan({ text: t("agentLabel", { agent: sourceLabel(review) }) });
    metadata.createSpan({ text: t("revisionLabel", { revision: review.revision }) });
    metadata.createSpan({
      text: t("updatedLabel", { time: formatRelative(review.updatedAt) }),
    });

    if (review.conflict !== undefined) {
      const warning = this.contentEl.createDiv({
        cls: `obsreview-conflict-warning ${review.conflict.advisory ? "is-advisory" : "is-authoritative"}`,
      });
      warning.createEl("strong", {
        text: review.conflict.advisory
          ? t("potentialConflictTitle")
          : t("targetChangedTitle"),
      });
      warning.createEl("p", {
        text: review.conflict.advisory
          ? t("potentialConflictDescription")
          : t("targetChangedDescription"),
      });
    }

    const currentChange = selectChange(review, this.selectedChangeId);
    this.selectedChangeId = currentChange.id;
    renderFileSelector(this.contentEl, review, currentChange.id, (changeId) => {
      this.selectedChangeId = changeId;
      this.hunkIndex = 0;
      void this.refresh();
      void this.openNativeEditor(review, selectChange(review, changeId), this.nativeMode);
    });

    if (review.status === "conflicted" || review.conflict?.advisory === true) {
      await this.renderConflictContext(review, currentChange);
    }

    const actionBar = this.contentEl.createDiv({ cls: "obsreview-review-actions" });
    const mutable = review.status === "pending" || review.status === "conflicted";
    if (mutable && currentChange.proposalContent !== null) {
      addButton(actionBar, t("editProposal"), () =>
        this.openNativeEditor(review, currentChange, this.nativeMode),
      );
    }
    addButton(actionBar, t("previousHunk"), () => this.moveHunk(-1));
    addButton(actionBar, t("nextHunk"), () => this.moveHunk(1));

    // The review page and the native editor page are separate surfaces, so this
    // control only re-lays out the sidebar diff and leaves the native pair mode
    // alone.
    const effectiveMode = this.effectiveMode();
    this.contentEl.toggleClass("is-auto-mode", this.modePreference === "auto");
    const modeToolbar = this.contentEl.createDiv({ cls: "obsreview-view-mode-toggle" });
    addToggle(modeToolbar, t("unified"), effectiveMode === "unified", () => {
      this.modePreference = "unified";
      this.mode = "unified";
      void this.refresh();
    });
    addToggle(modeToolbar, t("split"), effectiveMode === "split", () => {
      this.modePreference = "split";
      this.mode = "split";
      void this.refresh();
    });

    const base = currentChange.baseContent ?? "";
    const proposal = currentChange.proposalContent ?? "";
    const diff = this.service.diffEngine.diff(base, proposal);
    const diffSummary = this.contentEl.createDiv({ cls: "obsreview-diff-summary" });
    diffSummary.createSpan({ text: operationLabel(currentChange.operation) });
    diffSummary.createEl("code", { text: currentChange.target });
    if (currentChange.newTarget !== undefined) {
      diffSummary.createSpan({ text: `→ ${currentChange.newTarget}` });
    }
    diffSummary.createSpan({
      text: t(diff.stats.hunkCount === 1 ? "diffSummaryOne" : "diffSummaryMany", {
        added: diff.stats.addedLines,
        removed: diff.stats.removedLines,
        count: diff.stats.hunkCount,
      }),
    });

    const hunks = this.contentEl.createDiv({ cls: "obsreview-hunks" });
    if (diff.hunks.length === 0) {
      hunks.createEl("p", { cls: "obsreview-empty", text: t("proposalMatchesBase") });
    } else {
      this.hunkIndex = clamp(this.hunkIndex, 0, diff.hunks.length - 1);
      for (const hunk of diff.hunks) {
        const decision = currentChange.hunkDecisions[hunk.id]?.decision;
        renderHunk({
          parent: hunks,
          hunk,
          mode: this.mode,
          callbacks: {
            ...(decision === undefined ? {} : { decision }),
            readOnly: !mutable || currentChange.proposalContent === null,
            ...(mutable && currentChange.proposalContent !== null
              ? {
                  onAccept: async (selected: DiffHunk) => {
                    await this.decideHunk(review, currentChange, selected, "accepted");
                  },
                  onReject: async (selected: DiffHunk) => {
                    await this.decideHunk(review, currentChange, selected, "rejected");
                  },
                }
              : {}),
          },
        });
      }
    }

    if (mutable) this.renderFinalActions(review);
  }

  private async renderConflictContext(review: Review, change: ReviewChange): Promise<void> {
    try {
      const contexts = await this.service.conflictContext(review.id);
      const context = contexts.find((candidate) => candidate.changeId === change.id);
      if (context === undefined) return;
      const wrapper = this.contentEl.createDiv({ cls: "obsreview-three-way" });
      for (const item of [
        { label: t("base"), content: context.base },
        { label: t("current"), content: context.current },
        { label: t("proposal"), content: context.proposal },
      ]) {
        const panel = wrapper.createDiv({ cls: "obsreview-three-way-panel" });
        panel.createEl("h4", { text: item.label });
        panel.createEl("pre", { text: item.content ?? t("fileDoesNotExist") });
      }
      const actions = this.contentEl.createDiv({ cls: "obsreview-conflict-actions" });
      addButton(actions, t("rebaseReview"), async () => {
        try {
          await this.service.rebase(review.id, { expectedRevision: review.revision });
          new Notice(t("reviewRebased"));
          await this.refresh();
        } catch (error) {
          if (await this.refreshAfterRevisionConflict(error)) return;
          new Notice(t("automaticRebaseUnsafe", { error: message(error) }));
          await this.refresh();
        }
      });
      addButton(
        actions,
        t("forceApplyEllipsis"),
        () => this.confirmForceApply(review),
        "mod-warning",
      );
    } catch (error) {
      this.contentEl.createEl("p", {
        cls: "obsreview-error",
        text: t("conflictContextLoadFailed", { error: message(error) }),
      });
    }
  }

  private renderFinalActions(review: Review): void {
    const footer = this.contentEl.createDiv({ cls: "obsreview-final-actions" });
    if (hasAcceptedHunks(review)) {
      // Batching: write what has been accepted and keep reading the rest later.
      addButton(footer, t("submitAcceptedBlocks"), async () => {
        try {
          const result = await this.service.approve(review.id, {
            onlyAccepted: true,
            expectedRevision: review.revision,
            actor: "obsidian-user",
          });
          if (result.review.status === "pending") {
            new Notice(t("acceptedBlocksSubmitted"));
          } else {
            new Notice(
              result.maintenancePending === true
                ? t("reviewAppliedMaintenancePending")
                : t("reviewApproved"),
            );
          }
          if (result.review.status !== "pending") this.selectedReviewId = null;
          await this.refresh();
        } catch (error) {
          if (await this.refreshAfterRevisionConflict(error)) return;
          new Notice(t("approveRefused", { error: message(error) }));
          await this.refresh();
        }
      });
    }
    addButton(footer, t("approveReview"), async () => {
      try {
        const result = await this.service.approve(review.id, {
          expectedRevision: review.revision,
          actor: "obsidian-user",
        });
        new Notice(
          result.maintenancePending === true
            ? t("reviewAppliedMaintenancePending")
            : t("reviewApproved"),
        );
        this.selectedReviewId = null;
        await this.refresh();
      } catch (error) {
        if (await this.refreshAfterRevisionConflict(error)) return;
        new Notice(t("approveRefused", { error: message(error) }));
        await this.refresh();
      }
    }, "mod-cta");
    addButton(footer, t("rejectReviewEllipsis"), () => {
      new ConfirmActionModal(this.app, {
        title: t("rejectReview"),
        explanation: t("rejectReviewDescription"),
        confirmationText: t("rejectReview"),
        dangerous: false,
        action: async () => {
          try {
            await this.service.reject(review.id, {
              expectedRevision: review.revision,
              actor: "obsidian-user",
            });
            new Notice(t("rejectedReviewNotice"));
            this.selectedReviewId = null;
            await this.refresh();
          } catch (error) {
            if (await this.refreshAfterRevisionConflict(error)) return;
            throw error;
          }
        },
      }).open();
    });
  }

  private async decideHunk(
    review: Review,
    change: ReviewChange,
    hunk: DiffHunk,
    decision: "accepted" | "rejected",
  ): Promise<void> {
    try {
      const updatedReview = await this.service.decideHunk(review.id, {
        changeId: change.id,
        hunkId: hunk.id,
        decision,
        expectedRevision: review.revision,
        actor: "obsidian-user",
      });
      await this.openNativeEditor(
        updatedReview,
        selectChange(updatedReview, change.id),
        this.nativeMode,
      );
      new Notice(
        decision === "accepted"
          ? t("hunkAccepted")
          : t("hunkRejected"),
      );
      await this.refresh();
      } catch (error) {
        if (await this.refreshAfterRevisionConflict(error)) return;
        new Notice(t("hunkDecisionFailed", { error: message(error) }));
        await this.refresh();
    }
  }

  private confirmForceApply(review: Review): void {
    new ConfirmActionModal(this.app, {
      title: t("forceApplyTitle"),
      explanation: t("forceApplyDanger"),
      confirmationText: t("forceApply"),
      dangerous: true,
      action: async () => {
        try {
          const result = await this.service.approve(review.id, {
            force: true,
            expectedRevision: review.revision,
            actor: "obsidian-user",
          });
          new Notice(
            result.maintenancePending === true
              ? t("conflictedForceAppliedMaintenancePending")
              : t("conflictedForceApplied"),
          );
          this.selectedReviewId = null;
          await this.refresh();
        } catch (error) {
          if (await this.refreshAfterRevisionConflict(error)) return;
          throw error;
        }
      },
    }).open();
  }

  private moveHunk(delta: number): void {
    const elements = Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".obsreview-hunk"),
    );
    if (elements.length === 0) return;
    this.hunkIndex = (this.hunkIndex + delta + elements.length) % elements.length;
    elements[this.hunkIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
    this.focusNativeHunk(this.hunkIndex);
  }

  private async refreshAfterRevisionConflict(error: unknown): Promise<boolean> {
    if (!(error instanceof ReviewError) || error.code !== "REVISION_CONFLICT") return false;
    await this.refresh();
    new Notice(t("reviewAutoRefreshed"));
    return true;
  }

  /** A narrow sidebar cannot show two readable columns. */
  private autoMode(): DiffMode {
    return this.contentEl.clientWidth <= 520 ? "unified" : "split";
  }

  private effectiveMode(): DiffMode {
    return this.modePreference === "auto" ? this.autoMode() : this.modePreference;
  }
}

function renderFileSelector(
  parent: HTMLElement,
  review: Review,
  selectedChangeId: string,
  onSelect: (changeId: string) => void,
): void {
  const list = parent.createDiv({ cls: "obsreview-file-list" });
  for (const change of review.changes) {
    const button = list.createEl("button", {
      cls: change.id === selectedChangeId ? "is-active" : "",
    });
    renderCjkWrappedText(button, `${operationSymbol(change.operation)} ${change.target}`);
    button.addEventListener("click", () => onSelect(change.id));
  }
}

function selectChange(review: Review, changeId: string | null): ReviewChange {
  const selected = review.changes.find((change) => change.id === changeId);
  const first = selected ?? review.changes[0];
  if (first === undefined) throw new Error(t("reviewHasNoChanges"));
  return first;
}

function addButton(
  parent: HTMLElement,
  text: string,
  action: () => void | Promise<void>,
  className = "",
): HTMLButtonElement {
  const button = parent.createEl("button", { text, cls: className });
  button.addEventListener("click", () => void action());
  return button;
}

function addToggle(
  parent: HTMLElement,
  text: string,
  active: boolean,
  action: () => void,
): void {
  const button = addButton(parent, text, action, active ? "is-active" : "");
  button.setAttribute("aria-pressed", String(active));
}

function sourceLabel(review: Review): string {
  const agent = review.source?.agent;
  const session = review.source?.session;
  if (agent !== undefined && session !== undefined) return `${agent}/${session}`;
  return agent ?? session ?? t("externalAgent");
}

function operationSymbol(operation: ReviewChange["operation"]): string {
  switch (operation) {
    case "create":
      return "A";
    case "modify":
      return "M";
    case "delete":
      return "D";
    case "rename":
      return "R";
  }
}

function isTerminal(review: Review): boolean {
  return review.status === "approved" || review.status === "rejected" || review.status === "cancelled";
}

/**
 * True when at least one change block was explicitly accepted, which is what
 * makes a partial submission meaningful.
 */
function hasAcceptedHunks(review: Review): boolean {
  return review.changes.some((change) =>
    Object.values(change.hunkDecisions).some(
      (decision) => decision.decision === "accepted",
    ),
  );
}

function tabLabel(tab: ReviewTab): string {
  switch (tab) {
    case "pending":
      return t("tabPending");
    case "conflicted":
      return t("tabConflicted");
    case "history":
      return t("tabHistory");
  }
}

function statusLabel(status: Review["status"]): string {
  switch (status) {
    case "pending":
      return t("statusPending");
    case "approved":
      return t("statusApproved");
    case "rejected":
      return t("statusRejected");
    case "conflicted":
      return t("statusConflicted");
    case "cancelled":
      return t("statusCancelled");
  }
}

function operationLabel(operation: ReviewChange["operation"]): string {
  switch (operation) {
    case "create":
      return t("operationCreate");
    case "modify":
      return t("operationModify");
    case "delete":
      return t("operationDelete");
    case "rename":
      return t("operationRename");
  }
}

function formatRelative(timestamp: string): string {
  const milliseconds = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return timestamp;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return t("relativeSeconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("relativeMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("relativeHours", { count: hours });
  return t("relativeDays", { count: Math.floor(hours / 24) });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
