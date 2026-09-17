import {
  Notice,
  Plugin,
  TFile,
  type TAbstractFile,
  type WorkspaceLeaf,
} from "obsidian";
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
  private pendingTargets = new Set<string>();
  private targetTimer: NodeJS.Timeout | null = null;
  private inspectingTargets = false;
  private targetInspectionStopped = false;

  public override async onload(): Promise<void> {
    this.targetInspectionStopped = false;
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
          (review, change, mode) => nativeEditor.open(review, change, mode),
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
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item
            .setTitle(t("fileHistory"))
            .setIcon("history")
            .onClick(() => void this.openFileHistory(file.path)),
        );
      }),
    );
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
    this.targetInspectionStopped = true;
    if (this.targetTimer !== null) clearTimeout(this.targetTimer);
    this.targetTimer = null;
    this.pendingTargets.clear();
  }

  private async openView(): Promise<ReviewGateView | null> {
    if (this.service === null) {
      new Notice(t("reviewUnavailable"));
      return null;
    }
    let leaf = this.app.workspace.getLeavesOfType(REVIEW_GATE_VIEW_TYPE)[0];
    if (leaf === undefined) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (leaf === undefined) {
        new Notice(t("targetLeafUnavailable"));
        return null;
      }
      await leaf.setViewState({ type: REVIEW_GATE_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof ReviewGateView ? leaf.view : null;
  }

  private async openFileHistory(vaultPath: string): Promise<void> {
    const view = await this.openView();
    if (view !== null) await view.showFileHistory(vaultPath);
  }

  private async refreshViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_GATE_VIEW_TYPE)) {
      if (leaf.view instanceof ReviewGateView) await leaf.view.refresh();
    }
  }

  private scheduleTargetInspection(vaultPath: string): void {
    if (this.targetInspectionStopped) return;
    const normalized = vaultPath.replace(/\\/gu, "/");
    if (normalized === ".obsreview" || normalized.startsWith(".obsreview/")) return;
    this.pendingTargets.add(normalized);
    this.scheduleTargetBatch();
  }

  private scheduleTargetBatch(): void {
    if (this.inspectingTargets || this.targetInspectionStopped) return;
    if (this.targetTimer !== null) clearTimeout(this.targetTimer);
    this.targetTimer = setTimeout(() => {
      this.targetTimer = null;
      void this.inspectTargets();
    }, 200);
  }

  private async inspectTargets(): Promise<void> {
    if (this.service === null || this.targetInspectionStopped) return;
    // 启动会产生数千个文件事件；每批只读取一次列表，并串行处理后续批次。
    const targets = this.pendingTargets;
    this.pendingTargets = new Set<string>();
    this.inspectingTargets = true;
    try {
      const reviews = await this.service.list({ locations: ["pending"] });
      for (const review of reviews) {
        if (this.targetInspectionStopped) return;
        const related = review.changes.some(
          (change) => targets.has(change.target) ||
            (change.newTarget !== undefined && targets.has(change.newTarget)),
        );
        if (related) await this.service.markPotentialConflict(review.id);
      }
      if (!this.targetInspectionStopped) await this.refreshViews();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("Obsidian Review Gate target watcher failed", error);
    } finally {
      this.inspectingTargets = false;
      if (this.pendingTargets.size > 0) this.scheduleTargetBatch();
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
