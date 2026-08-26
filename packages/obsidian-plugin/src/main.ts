import { Notice, Plugin, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { ReviewService } from "../../core/src/service/review-service";
import { installReviewFileSystem } from "../../core/src/storage/file-system";
import { userDataReviewStorageBase } from "../../core/src/storage/user-data";
import { NativeEditorCoordinator } from "./editor/native-editor-coordinator";
import { nativeDiffEditorExtension } from "./editor/native-diff-extension";
import { createNativeMarkdownPair } from "./editor/native-markdown-pair";
import { t } from "./i18n";
import { ObsidianReviewFileSystem } from "./storage/obsidian-file-system";
import { ReviewSessionOperations } from "./ui/review-session-operations";
import { ReviewGateView, REVIEW_GATE_VIEW_TYPE } from "./ui/review-view";
import { ReviewWatcher } from "./watcher/review-watcher";

export default class ObsidianReviewGatePlugin extends Plugin {
  private service: ReviewService | null = null;
  private watcher: ReviewWatcher | null = null;
  private nativeEditor: NativeEditorCoordinator | null = null;
  private targetTimers = new Map<string, NodeJS.Timeout>();

  public override async onload(): Promise<void> {
    const getBasePath = this.app.vault.adapter.getBasePath;
    if (typeof getBasePath !== "function") {
      new Notice(t("desktopRequired"));
      return;
    }
    this.registerEditorExtension(nativeDiffEditorExtension);
    const vaultRoot = getBasePath.call(this.app.vault.adapter);
    const storageBase = userDataReviewStorageBase(vaultRoot);
    const restoreFileSystem = installReviewFileSystem(
      new ObsidianReviewFileSystem(vaultRoot, this.app.vault.adapter),
    );
    this.register(restoreFileSystem);
    const opened = await ReviewService.open(vaultRoot, { storageBase });
    this.service = opened.service;
    const operations = new ReviewSessionOperations(opened.service, async () => {
      await this.refreshViews();
    });
    const nativeEditor = new NativeEditorCoordinator({
      service: opened.service,
      operations,
      createPair: (request) => createNativeMarkdownPair(this.app, request),
    });
    this.nativeEditor = nativeEditor;
    this.register(() => nativeEditor.close());
    this.registerView(
      REVIEW_GATE_VIEW_TYPE,
      (leaf: WorkspaceLeaf) =>
        new ReviewGateView(
          leaf,
          opened.service,
          (review, change) => nativeEditor.open(review, change),
          (index) => nativeEditor.focusHunk(index),
        ),
    );
    this.addRibbonIcon("file-check-2", t("openReviewGate"), () => void this.openView());
    this.addCommand({
      id: "open-review-gate",
      name: t("openReviewGate"),
      callback: () => void this.openView(),
    });
    this.addCommand({
      id: "refresh-review-gate",
      name: t("refreshReviewGate"),
      callback: () => void this.refreshViews(),
    });
    this.watcher = new ReviewWatcher(storageBase, async () => {
      const activeReviewId = nativeEditor.activeReviewId();
      if (activeReviewId !== null) {
        const review = await opened.service.get(activeReviewId);
        if (review.status === "approved") nativeEditor.closeApproved(review.id);
      }
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
    this.showRecoveryNotice(opened.recovery);
  }

  public override onunload(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.nativeEditor?.close();
    this.nativeEditor = null;
    for (const timer of this.targetTimers.values()) clearTimeout(timer);
    this.targetTimers.clear();
  }

  private async openView(): Promise<void> {
    if (this.service === null) {
      new Notice(t("reviewUnavailable"));
      return;
    }
    let leaf = this.app.workspace.getLeavesOfType(REVIEW_GATE_VIEW_TYPE)[0];
    if (leaf === undefined) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (leaf === undefined) {
        new Notice(t("targetLeafUnavailable"));
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
      if (!(error instanceof Error)) throw error;
      console.error("Obsidian Review Gate target watcher failed", error);
    }
  }

  private showRecoveryNotice(recovery: readonly { readonly action: string }[]): void {
    if (recovery.length === 0) return;
    const manualCount = recovery.filter((item) => item.action === "left-for-manual-recovery").length;
    new Notice(
      manualCount === 0
        ? t(recovery.length === 1 ? "recoveredTransactionsOne" : "recoveredTransactionsMany", {
            count: recovery.length,
          })
        : t(manualCount === 1 ? "manualRecoveryTransactionsOne" : "manualRecoveryTransactionsMany", {
            count: manualCount,
          }),
      10_000,
    );
  }
}
