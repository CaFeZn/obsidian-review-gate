import { Notice } from "obsidian";
import { ReviewError } from "../../../core/src/model/errors";
import type { HunkDecisionKind, Review } from "../../../core/src/model/review";
import type { ApplyResult } from "../../../core/src/patch/apply";
import type { ReviewService } from "../../../core/src/service/review-service";
import type {
  HunkDecisionResult,
  ReviewEditingSession,
} from "../editor/review-editing-session";
import { t } from "../i18n";
import { message } from "./modals";

export interface HunkCommand {
  readonly changeId: string;
  readonly hunkIndex: number;
  readonly decision: HunkDecisionKind;
}

interface ReviewUpdateOptions {
  readonly refreshNativeEditor?: boolean;
}

type ReviewUpdated = (review: Review, options?: ReviewUpdateOptions) => Promise<void>;

export class ReviewSessionOperations {
  public constructor(
    private readonly service: ReviewService,
    private readonly onReviewUpdated: ReviewUpdated,
  ) {}

  public async save(
    session: ReviewEditingSession,
    changeId: string,
  ): Promise<Review | null> {
    try {
      const review = await session.saveChange(changeId);
      new Notice(t("proposalUpdated"));
      await this.onReviewUpdated(review);
      return review;
    } catch (error) {
      if (await this.refreshAfterRevisionConflict(session, error)) return null;
      if (!(error instanceof Error)) throw error;
      new Notice(t("proposalSaveFailed", { error: message(error) }));
      return null;
    }
  }

  public async decide(
    session: ReviewEditingSession,
    command: HunkCommand,
  ): Promise<HunkDecisionResult | null> {
    try {
      const result = await session.decideHunk(
        command.changeId,
        command.hunkIndex,
        command.decision,
      );
      new Notice(command.decision === "accepted" ? t("hunkAccepted") : t("hunkRejected"));
      await this.onReviewUpdated(result.review);
      return result;
    } catch (error) {
      if (await this.refreshAfterRevisionConflict(session, error)) return null;
      if (!(error instanceof Error)) throw error;
      new Notice(t("hunkDecisionFailed", { error: message(error) }));
      return null;
    }
  }

  public async approve(session: ReviewEditingSession): Promise<ApplyResult | null> {
    try {
      const result = await session.approve();
      new Notice(
        result.maintenancePending === true
          ? t("reviewAppliedMaintenancePending")
          : t("reviewApproved"),
      );
      await this.onReviewUpdated(result.review);
      return result;
    } catch (error) {
      if (await this.refreshAfterRevisionConflict(session, error)) return null;
      if (!(error instanceof Error)) throw error;
      new Notice(t("approveRefused", { error: message(error) }));
      return null;
    }
  }

  public async submitAccepted(session: ReviewEditingSession): Promise<ApplyResult | null> {
    try {
      const result = await session.submitAccepted();
      new Notice(
        result.review.status === "pending"
          ? t("acceptedBlocksSubmitted")
          : result.maintenancePending === true
            ? t("reviewAppliedMaintenancePending")
            : t("reviewApproved"),
      );
      await this.onReviewUpdated(result.review);
      return result;
    } catch (error) {
      if (await this.refreshAfterRevisionConflict(session, error)) return null;
      if (!(error instanceof Error)) throw error;
      new Notice(t("approveRefused", { error: message(error) }));
      return null;
    }
  }

  public async rebase(session: ReviewEditingSession): Promise<Review | null> {
    try {
      const saved = await session.saveAll();
      const review = await this.service.rebase(saved.id, {
        expectedRevision: saved.revision,
      });
      session.acceptRefresh(review);
      new Notice(t("reviewRebased"));
      await this.onReviewUpdated(review);
      return review;
    } catch (error) {
      if (await this.refreshAfterRevisionConflict(session, error)) return null;
      if (!(error instanceof Error)) throw error;
      new Notice(t("automaticRebaseUnsafe", { error: message(error) }));
      return null;
    }
  }

  public async forceApply(session: ReviewEditingSession): Promise<ApplyResult | null> {
    try {
      const saved = await session.saveAll();
      const result = await this.service.approve(saved.id, {
        force: true,
        expectedRevision: saved.revision,
        actor: "obsidian-user",
      });
      new Notice(
        result.maintenancePending === true
          ? t("conflictedForceAppliedMaintenancePending")
          : t("conflictedForceApplied"),
      );
      await this.onReviewUpdated(result.review);
      return result;
    } catch (error) {
      if (await this.refreshAfterRevisionConflict(session, error)) return null;
      if (!(error instanceof Error)) throw error;
      new Notice(t("approveRefused", { error: message(error) }));
      return null;
    }
  }

  public async reject(session: ReviewEditingSession): Promise<Review | null> {
    try {
      const snapshot = session.snapshot();
      const review = await this.service.reject(snapshot.id, {
        expectedRevision: snapshot.revision,
        actor: "obsidian-user",
      });
      session.acceptRefresh(review);
      new Notice(t("rejectedReviewNotice"));
      await this.onReviewUpdated(review);
      return review;
    } catch (error) {
      if (await this.refreshAfterRevisionConflict(session, error)) return null;
      if (!(error instanceof Error)) throw error;
      new Notice(t("actionFailed", { error: message(error) }));
      return null;
    }
  }

  private async refreshAfterRevisionConflict(
    session: ReviewEditingSession,
    error: unknown,
  ): Promise<boolean> {
    if (!(error instanceof ReviewError) || error.code !== "REVISION_CONFLICT") return false;
    try {
      const latest = await this.service.get(session.snapshot().id);
      const applied = session.acceptRefresh(latest);
      await this.onReviewUpdated(
        latest,
        applied ? { refreshNativeEditor: true } : undefined,
      );
      new Notice(t(applied ? "reviewAutoRefreshed" : "externalRefreshDeferred"));
      return true;
    } catch {
      return false;
    }
  }
}
