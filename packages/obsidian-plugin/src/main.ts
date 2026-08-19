import { Notice, Plugin, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { ReviewService } from "../../core/src/service/review-service";
import { userDataReviewStorageBase } from "../../core/src/storage/user-data";
import { ReviewWatcher } from "./watcher/review-watcher";
import { ReviewGateView, REVIEW_GATE_VIEW_TYPE } from "./ui/review-view";

export default class ObsidianReviewGatePlugin extends Plugin {
  private service: ReviewService | null = null;
  private watcher: ReviewWatcher | null = null;
  private targetTimers = new Map<string, NodeJS.Timeout>();

  public override async onload(): Promise<void> {
    const getBasePath = this.app.vault.adapter.getBasePath;
    if (typeof getBasePath !== "function") {
      new Notice("Obsidian Review Gate requires Obsidian Desktop with a filesystem vault.");
      return;
    }
    const vaultRoot = getBasePath.call(this.app.vault.adapter);
    const storageBase = userDataReviewStorageBase(vaultRoot);
    const opened = await ReviewService.open(vaultRoot, { storageBase });
    this.service = opened.service;

    this.registerView(
      REVIEW_GATE_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new ReviewGateView(leaf, opened.service),
    );
    this.addRibbonIcon("file-check-2", "Open Review Gate", () => void this.openView());
    this.addCommand({
      id: "open-review-gate",
      name: "Open Review Gate",
      callback: () => void this.openView(),
    });
    this.addCommand({
      id: "refresh-review-gate",
      name: "Refresh Review Gate",
      callback: () => void this.refreshViews(),
    });

    this.watcher = new ReviewWatcher(storageBase, async () => {
      await this.refreshViews();
    });
    await this.watcher.start();
    this.register(() => this.watcher?.stop());

    for (const eventName of ["modify", "create", "delete"] as const) {
      this.registerEvent(
        this.app.vault.on(eventName, (file: TAbstractFile) => {
          this.scheduleTargetInspection(file.path);
        }),
      );
    }
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        this.scheduleTargetInspection(oldPath);
        this.scheduleTargetInspection(file.path);
      }),
    );

    if (opened.recovery.length > 0) {
      const manual = opened.recovery.filter(
        (item) => item.action === "left-for-manual-recovery",
      );
      new Notice(
        manual.length === 0
          ? `Review Gate recovered ${opened.recovery.length} interrupted transaction(s).`
          : `${manual.length} Review Gate transaction(s) require manual recovery.`,
        10_000,
      );
    }
  }

  public override onunload(): void {
    this.watcher?.stop();
    this.watcher = null;
    for (const timer of this.targetTimers.values()) clearTimeout(timer);
    this.targetTimers.clear();
  }

  private async openView(): Promise<void> {
    if (this.service === null) {
      new Notice("Review Gate is unavailable for this vault.");
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(REVIEW_GATE_VIEW_TYPE)[0];
    if (leaf === undefined) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (leaf === undefined) {
        new Notice("Could not allocate a Review Gate workspace leaf.");
        return;
      }
      await leaf.setViewState({ type: REVIEW_GATE_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }

  private async refreshViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_GATE_VIEW_TYPE)) {
      if (leaf.view instanceof ReviewGateView) await leaf.view.refresh();
    }
  }

  private scheduleTargetInspection(vaultPath: string): void {
    if (vaultPath === ".obsreview" || vaultPath.startsWith(".obsreview/")) return;
    const normalized = vaultPath.replace(/\\/gu, "/");
    const previous = this.targetTimers.get(normalized);
    if (previous !== undefined) clearTimeout(previous);
    this.targetTimers.set(
      normalized,
      setTimeout(() => {
        this.targetTimers.delete(normalized);
        void this.inspectTarget(normalized);
      }, 200),
    );
  }

  private async inspectTarget(vaultPath: string): Promise<void> {
    if (this.service === null) return;
    try {
      const reviews = await this.service.list({ locations: ["pending"] });
      for (const review of reviews) {
        const related = review.changes.some(
          (change) => change.target === vaultPath || change.newTarget === vaultPath,
        );
        if (related) await this.service.markPotentialConflict(review.id);
      }
      await this.refreshViews();
    } catch (error) {
      console.error("Obsidian Review Gate target watcher failed", error);
    }
  }
}
