import type { DiffEngine, DiffResult } from "../../../core/src/diff/types";
import type {
  HunkDecisionKind,
  Review,
  ReviewChange,
} from "../../../core/src/model/review";
import type { ApplyResult, ApproveOptions } from "../../../core/src/patch/apply";
import type {
  HunkDecisionInput,
  UpdateProposalInput,
} from "../../../core/src/service/review-service";

export interface ReviewSessionService {
  readonly diffEngine: DiffEngine;
  updateProposal(reviewId: string, input: UpdateProposalInput): Promise<Review>;
  decideHunk(reviewId: string, input: HunkDecisionInput): Promise<Review>;
  approve(reviewId: string, options?: ApproveOptions): Promise<ApplyResult>;
}

export interface HunkDecisionResult {
  readonly review: Review;
  readonly hunkIndex: number;
}

export class ReviewEditingSession {
  private review: Review;
  private readonly drafts = new Map<string, string>();

  public constructor(
    private readonly service: ReviewSessionService,
    review: Review,
  ) {
    this.review = review;
  }

  public snapshot(): Review {
    return this.review;
  }

  public proposal(changeId: string): string {
    const draft = this.drafts.get(changeId);
    if (draft !== undefined) return draft;
    return proposalChange(this.review, changeId).proposalContent ?? "";
  }

  public updateDraft(changeId: string, proposalContent: string): void {
    const savedProposal = proposalChange(this.review, changeId).proposalContent;
    if (proposalContent === savedProposal) {
      this.drafts.delete(changeId);
      return;
    }
    this.drafts.set(changeId, proposalContent);
  }

  public isDirty(changeId: string): boolean {
    return this.drafts.has(changeId);
  }

  public hasDirtyDrafts(): boolean {
    return this.drafts.size > 0;
  }

  public diff(changeId: string): DiffResult {
    const change = proposalChange(this.review, changeId);
    return this.service.diffEngine.diff(change.baseContent ?? "", this.proposal(changeId));
  }

  public acceptRefresh(review: Review): boolean {
    if (review.id !== this.review.id) {
      throw new ReviewSessionStateError("Review ID changed during session refresh.");
    }
    if (this.hasDirtyDrafts()) return false;
    this.review = review;
    return true;
  }

  public async saveChange(changeId: string): Promise<Review> {
    const change = proposalChange(this.review, changeId);
    const proposalContent = this.drafts.get(changeId);
    if (proposalContent === undefined) return this.review;
    const updated = await this.service.updateProposal(this.review.id, {
      changeId: change.id,
      proposalContent,
      expectedRevision: this.review.revision,
      actor: "obsidian-user",
    });
    this.review = updated;
    this.drafts.delete(changeId);
    return updated;
  }

  public async decideHunk(
    changeId: string,
    hunkIndex: number,
    decision: HunkDecisionKind,
  ): Promise<HunkDecisionResult> {
    await this.saveChange(changeId);
    const hunks = this.diff(changeId).hunks;
    if (hunks.length === 0) {
      throw new ReviewSessionStateError("The selected file has no current hunk.");
    }
    const nextIndex = Math.min(hunks.length - 1, Math.max(0, hunkIndex));
    const hunk = hunks[nextIndex];
    if (hunk === undefined) {
      throw new ReviewSessionStateError("The current hunk could not be resolved.");
    }
    const updated = await this.service.decideHunk(this.review.id, {
      changeId,
      hunkId: hunk.id,
      decision,
      expectedRevision: this.review.revision,
      actor: "obsidian-user",
    });
    this.review = updated;
    this.drafts.delete(changeId);
    const remainingHunks = this.diff(changeId).hunks.length;
    return {
      review: updated,
      hunkIndex: remainingHunks === 0 ? 0 : Math.min(nextIndex, remainingHunks - 1),
    };
  }

  public async saveAll(): Promise<Review> {
    for (const change of this.review.changes) {
      if (change.proposalContent !== null) await this.saveChange(change.id);
    }
    return this.review;
  }

  public async approve(): Promise<ApplyResult> {
    await this.saveAll();
    const result = await this.service.approve(this.review.id, {
      expectedRevision: this.review.revision,
      actor: "obsidian-user",
    });
    this.review = result.review;
    return result;
  }
}

export class ReviewSessionStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReviewSessionStateError";
  }
}

function proposalChange(review: Review, changeId: string): ReviewChange {
  const change = review.changes.find((candidate) => candidate.id === changeId);
  if (change === undefined || change.proposalContent === null) {
    throw new ReviewSessionStateError(`Change ${changeId} has no editable proposal.`);
  }
  return change;
}
