import { ItemView, Notice, WorkspaceLeaf, type TAbstractFile, type TFile } from "obsidian";
import type { Review, ReviewChange } from "../../../core/src/model/review";
import { ReviewError } from "../../../core/src/model/errors";
import type { ReviewService } from "../../../core/src/service/review-service";
import type { DiffHunk } from "../../../core/src/diff/types";
import { renderHunk, type DiffMode } from "./diff-renderer";
import { ConfirmActionModal, ProposalEditModal, message } from "./modals";

export const REVIEW_GATE_VIEW_TYPE = "obsidian-review-gate";

type ReviewTab = "pending" | "conflicted" | "history";

export class ReviewGateView extends ItemView {
  private tab: ReviewTab = "pending";
  private selectedReviewId: string | null = null;
  private selectedChangeId: string | null = null;
  private mode: DiffMode = "split";
  private hunkIndex = 0;
  private renderGeneration = 0;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    this.moveHunk(event.key === "ArrowDown" ? 1 : -1);
  };

  public constructor(
    leaf: WorkspaceLeaf,
    private readonly service: ReviewService,
  ) {
    super(leaf);
  }

  public getViewType(): string {
    return REVIEW_GATE_VIEW_TYPE;
  }

  public getDisplayText(): string {
    return "Review Gate";
  }

  public override getIcon(): string {
    return "file-check-2";
  }

  public override async onOpen(): Promise<void> {
    this.contentEl.addClass("obsreview-view");
    this.contentEl.tabIndex = 0;
    this.contentEl.addEventListener("keydown", this.onKeyDown);
    await this.refresh();
  }

  public override onClose(): void {
    this.contentEl.removeEventListener("keydown", this.onKeyDown);
    this.contentEl.empty();
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
        text: `Review Gate could not load: ${message(error)}`,
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

    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: "obsreview-header" });
    header.createEl("h2", { text: "Review Gate" });
    header.createSpan({ cls: "obsreview-count", text: String(filtered.length) });
    const tabs = this.contentEl.createDiv({ cls: "obsreview-tabs" });
    for (const tab of ["pending", "conflicted", "history"] as const) {
      const button = tabs.createEl("button", {
        text: titleCase(tab),
        cls: this.tab === tab ? "is-active" : "",
      });
      button.addEventListener("click", () => {
        this.tab = tab;
        this.selectedReviewId = null;
        void this.refresh();
      });
    }

    if (filtered.length === 0) {
      this.contentEl.createEl("p", {
        cls: "obsreview-empty",
        text:
          this.tab === "history"
            ? "No completed reviews."
            : this.tab === "conflicted"
              ? "No conflicted reviews."
              : "No pending reviews.",
      });
      return;
    }

    const list = this.contentEl.createDiv({ cls: "obsreview-list" });
    for (const review of filtered) {
      const card = list.createDiv({ cls: "obsreview-card" });
      card.tabIndex = 0;
      const heading = card.createDiv({ cls: "obsreview-card-heading" });
      heading.createEl("strong", { text: `#${review.id.slice(-8)}` });
      heading.createSpan({
        cls: `obsreview-status is-${review.status}`,
        text: review.conflict?.advisory === true ? "potential conflict" : review.status,
      });
      card.createEl("div", {
        cls: "obsreview-card-target",
        text:
          review.changes.length === 1
            ? review.changes[0]?.target ?? "Unknown target"
            : `${review.changes.length} files`,
      });
      const source = sourceLabel(review);
      card.createEl("small", {
        text: `${source} · revision ${review.revision} · ${formatRelative(review.updatedAt)}`,
      });
      const open = (): void => {
        this.selectedReviewId = review.id;
        this.selectedChangeId = review.changes[0]?.id ?? null;
        this.hunkIndex = 0;
        void this.refresh();
      };
      card.addEventListener("click", open);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") open();
      });
    }
  }

  private async renderReview(review: Review): Promise<void> {
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv({ cls: "obsreview-detail-toolbar" });
    addButton(toolbar, "← Back", () => {
      this.selectedReviewId = null;
      this.selectedChangeId = null;
      void this.refresh();
    });
    toolbar.createEl("h2", { text: `Review #${review.id.slice(-8)}` });
    toolbar.createSpan({
      cls: `obsreview-status is-${review.status}`,
      text: review.status,
    });

    const metadata = this.contentEl.createDiv({ cls: "obsreview-metadata" });
    metadata.createSpan({ text: `Agent: ${sourceLabel(review)}` });
    metadata.createSpan({ text: `Revision: ${review.revision}` });
    metadata.createSpan({ text: `Updated: ${formatRelative(review.updatedAt)}` });

    if (review.conflict !== undefined) {
      const warning = this.contentEl.createDiv({
        cls: `obsreview-conflict-warning ${review.conflict.advisory ? "is-advisory" : "is-authoritative"}`,
      });
      warning.createEl("strong", {
        text: review.conflict.advisory
          ? "⚠ Potential conflict"
          : "⚠ Target changed since this proposal was created",
      });
      warning.createEl("p", {
        text: review.conflict.advisory
          ? "A watcher observed a target change. Approve will recompute every base hash before any write."
          : "Direct apply is blocked. Rebase, reject, or use explicit Force Apply after reviewing Base / Current / Proposal.",
      });
    }

    const currentChange = selectChange(review, this.selectedChangeId);
    this.selectedChangeId = currentChange.id;
    renderFileSelector(this.contentEl, review, currentChange.id, (changeId) => {
      this.selectedChangeId = changeId;
      this.hunkIndex = 0;
      void this.refresh();
    });

    if (review.status === "conflicted" || review.conflict?.advisory === true) {
      await this.renderConflictContext(review, currentChange);
    }

    const actionBar = this.contentEl.createDiv({ cls: "obsreview-review-actions" });
    const mutable = review.status === "pending" || review.status === "conflicted";
    if (mutable && currentChange.proposalContent !== null) {
      addButton(actionBar, "Edit proposal", () => this.editProposal(review, currentChange));
      addButton(actionBar, "Open proposal note", () =>
        this.openProposalNote(review, currentChange),
      );
    }
    addToggle(actionBar, "Unified", this.mode === "unified", () => {
      this.mode = "unified";
      void this.refresh();
    });
    addToggle(actionBar, "Split", this.mode === "split", () => {
      this.mode = "split";
      void this.refresh();
    });
    addButton(actionBar, "Previous hunk", () => this.moveHunk(-1));
    addButton(actionBar, "Next hunk", () => this.moveHunk(1));

    const base = currentChange.baseContent ?? "";
    const proposal = currentChange.proposalContent ?? "";
    const diff = this.service.diffEngine.diff(base, proposal);
    const diffSummary = this.contentEl.createDiv({ cls: "obsreview-diff-summary" });
    diffSummary.createSpan({ text: currentChange.operation.toUpperCase() });
    diffSummary.createEl("code", { text: currentChange.target });
    if (currentChange.newTarget !== undefined) {
      diffSummary.createSpan({ text: `→ ${currentChange.newTarget}` });
    }
    diffSummary.createSpan({
      text: `+${diff.stats.addedLines} −${diff.stats.removedLines} · ${diff.stats.hunkCount} hunks`,
    });

    const hunks = this.contentEl.createDiv({ cls: "obsreview-hunks" });
    if (diff.hunks.length === 0) {
      hunks.createEl("p", { cls: "obsreview-empty", text: "Proposal matches base." });
    } else {
      this.hunkIndex = clamp(this.hunkIndex, 0, diff.hunks.length - 1);
      for (const hunk of diff.hunks) {
        const decision = currentChange.hunkDecisions[hunk.id]?.decision;
        renderHunk(hunks, hunk, this.mode, {
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
        { label: "Base", content: context.base },
        { label: "Current", content: context.current },
        { label: "Proposal", content: context.proposal },
      ]) {
        const panel = wrapper.createDiv({ cls: "obsreview-three-way-panel" });
        panel.createEl("h4", { text: item.label });
        panel.createEl("pre", { text: item.content ?? "(file does not exist)" });
      }
      const actions = this.contentEl.createDiv({ cls: "obsreview-conflict-actions" });
      addButton(actions, "Refresh / Rebase", async () => {
        try {
          await this.service.rebase(review.id, { expectedRevision: review.revision });
          new Notice("Review rebased onto current target state.");
          await this.refresh();
        } catch (error) {
          new Notice(`Automatic rebase was not safe: ${message(error)}`);
          await this.refresh();
        }
      });
      addButton(actions, "Force Apply…", () => this.confirmForceApply(review), "mod-warning");
    } catch (error) {
      this.contentEl.createEl("p", {
        cls: "obsreview-error",
        text: `Could not load conflict context: ${message(error)}`,
      });
    }
  }

  private renderFinalActions(review: Review): void {
    const footer = this.contentEl.createDiv({ cls: "obsreview-final-actions" });
    addButton(footer, "Approve review", async () => {
      try {
        const result = await this.service.approve(review.id, {
          expectedRevision: review.revision,
          actor: "obsidian-user",
        });
        new Notice(
          result.maintenancePending === true
            ? "Review applied. Backup housekeeping will be retried on next startup."
            : "Review approved and applied.",
        );
        this.selectedReviewId = null;
        await this.refresh();
      } catch (error) {
        new Notice(`Approve refused: ${message(error)}`);
        await this.refresh();
      }
    }, "mod-cta");
    addButton(footer, "Reject review…", () => {
      new ConfirmActionModal(
        this.app,
        "Reject review",
        "The proposal will move to history and the target files will remain unchanged.",
        "Reject review",
        false,
        async () => {
          await this.service.reject(review.id, {
            expectedRevision: review.revision,
            actor: "obsidian-user",
          });
          new Notice("Review rejected; no target file was written.");
          this.selectedReviewId = null;
          await this.refresh();
        },
      ).open();
    });
  }

  private async openProposalNote(review: Review, change: ReviewChange): Promise<void> {
    if (change.proposalContent === null) return;
    const proposalPath = `.obsreview/pending/${review.id}/changes/${change.id}/proposal.md`;
    const file = this.app.vault.getAbstractFileByPath(proposalPath);
    if (!isTFile(file)) {
      new Notice(`Proposal note is unavailable: ${proposalPath}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice(
      "Editing this proposal note updates pending state only; the target remains unchanged until Approve.",
      8_000,
    );
  }

  private editProposal(review: Review, change: ReviewChange): void {
    if (change.proposalContent === null) return;
    new ProposalEditModal(
      this.app,
      change.baseContent ?? "",
      change.proposalContent,
      this.mode,
      async (proposalContent) => {
        await this.service.updateProposal(review.id, {
          changeId: change.id,
          proposalContent,
          expectedRevision: review.revision,
          actor: "obsidian-user",
        });
        new Notice("Proposal updated. Target file is still unchanged.");
        await this.refresh();
      },
    ).open();
  }

  private async decideHunk(
    review: Review,
    change: ReviewChange,
    hunk: DiffHunk,
    decision: "accepted" | "rejected",
  ): Promise<void> {
    try {
      await this.service.decideHunk(review.id, {
        changeId: change.id,
        hunkId: hunk.id,
        decision,
        expectedRevision: review.revision,
        actor: "obsidian-user",
      });
      new Notice(
        decision === "accepted"
          ? "Hunk accepted in proposal state; target remains unchanged."
          : "Hunk rejected and restored to base in proposal state; target remains unchanged.",
      );
      await this.refresh();
    } catch (error) {
      new Notice(`Hunk decision failed: ${message(error)}`);
      await this.refresh();
    }
  }

  private confirmForceApply(review: Review): void {
    new ConfirmActionModal(
      this.app,
      "Force Apply conflicted review",
      "Danger: this bypasses base-hash conflict refusal and can overwrite current target changes. A recoverable backup is retained under .obsreview/trash. Use only after comparing Base, Current, and Proposal.",
      "Force Apply",
      true,
      async () => {
        const result = await this.service.approve(review.id, {
          force: true,
          expectedRevision: review.revision,
          actor: "obsidian-user",
        });
        new Notice(
          result.maintenancePending === true
            ? "Conflicted review was force-applied; backup housekeeping is pending."
            : "Conflicted review was force-applied.",
        );
        this.selectedReviewId = null;
        await this.refresh();
      },
    ).open();
  }

  private moveHunk(delta: number): void {
    const elements = Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".obsreview-hunk"),
    );
    if (elements.length === 0) return;
    this.hunkIndex = (this.hunkIndex + delta + elements.length) % elements.length;
    elements[this.hunkIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
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
      text: `${operationSymbol(change.operation)} ${change.target}`,
    });
    button.addEventListener("click", () => onSelect(change.id));
  }
}

function selectChange(review: Review, changeId: string | null): ReviewChange {
  const selected = review.changes.find((change) => change.id === changeId);
  const first = selected ?? review.changes[0];
  if (first === undefined) throw new Error("Review has no changes.");
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
  return agent ?? session ?? "external agent";
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

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatRelative(timestamp: string): string {
  const milliseconds = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return timestamp;
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isTFile(file: TAbstractFile | null): file is TFile {
  return file !== null && "extension" in file;
}
