import type {
  HunkDecisionKind,
  Review,
  ReviewChange,
} from "../../../core/src/model/review";
import type { DiffMode } from "../ui/diff-renderer";
import type { ApplyResult } from "../../../core/src/patch/apply";
import {
  ReviewEditingSession,
  type HunkDecisionResult,
  type ReviewSessionService,
} from "./review-editing-session";

export interface NativeEditorPair {
  isOpen(): boolean;
  isDirty?(): boolean;
  reveal(): Promise<void>;
  focusHunk(index: number): void;
  close(): void;
}

export interface NativeEditorPairUpdate {
  readonly proposalContent: string;
  readonly hunkIndex: number;
}

export interface NativeEditorPairRequest {
  readonly reviewId: string;
  readonly changeId: string;
  readonly target: string;
  readonly newTarget?: string;
  readonly baseContent: string;
  readonly proposalContent: string;
  readonly mode: DiffMode;
  readonly editable: boolean;
  readonly onClose: () => void;
  readonly onSave: (proposalContent: string) => Promise<void>;
  readonly hasAcceptedHunks: () => boolean;
  readonly onModeChange?: (
    mode: DiffMode,
    proposalContent?: string,
  ) => Promise<void>;
  readonly onDecideHunk: (
    proposalContent: string,
    hunkIndex: number,
    decision: HunkDecisionKind,
  ) => Promise<NativeEditorPairUpdate | null>;
  readonly onApprove: (proposalContent: string) => Promise<boolean>;
  readonly onSubmitAccepted: (proposalContent: string) => Promise<boolean>;
}

interface NativeReviewOperations {
  save(session: ReviewEditingSession, changeId: string): Promise<Review | null>;
  decide(
    session: ReviewEditingSession,
    command: {
      readonly changeId: string;
      readonly hunkIndex: number;
      readonly decision: HunkDecisionKind;
    },
  ): Promise<HunkDecisionResult | null>;
  approve(session: ReviewEditingSession): Promise<ApplyResult | null>;
  submitAccepted(session: ReviewEditingSession): Promise<ApplyResult | null>;
}

interface NativeEditorCoordinatorOptions {
  readonly service: ReviewSessionService;
  readonly operations: NativeReviewOperations;
  readonly createPair: (request: NativeEditorPairRequest) => Promise<NativeEditorPair>;
}

interface ActiveEditorSession {
  readonly reviewId: string;
  readonly changeId: string;
  readonly mode: DiffMode;
  readonly key: string;
  readonly pair: NativeEditorPair;
  readonly session: ReviewEditingSession;
  revision: number;
}

export class NativeEditorCoordinator {
  private generation = 0;
  private active: ActiveEditorSession | null = null;
  private mutationDepth = 0;

  public constructor(private readonly options: NativeEditorCoordinatorOptions) {}

  public async open(
    review: Review,
    change: ReviewChange,
    mode: DiffMode = "split",
  ): Promise<void> {
    const generation = ++this.generation;
    if (change.proposalContent === null) {
      this.disposeActive();
      return;
    }

    const editable = review.status === "pending" || review.status === "conflicted";
    const key = `${review.id}:${change.id}:${editable}:${mode}:${change.proposalHash}`;
    if (this.active?.key === key && this.active.pair.isOpen()) {
      await this.active.pair.reveal();
      return;
    }

    this.disposeActive();
    const session = new ReviewEditingSession(this.options.service, review);
    const request: NativeEditorPairRequest = {
      reviewId: review.id,
      changeId: change.id,
      target: change.target,
      ...(change.newTarget === undefined ? {} : { newTarget: change.newTarget }),
      baseContent: change.baseContent ?? "",
      proposalContent: change.proposalContent,
      mode,
      editable,
      onClose: () => {
        if (generation !== this.generation) return;
        this.generation += 1;
        this.disposeActive();
      },
      onSave: async (proposalContent) => {
        await this.runMutation(async () => {
          session.updateDraft(change.id, proposalContent);
          if (!session.isDirty(change.id)) return;
          await this.options.operations.save(session, change.id);
        });
      },
      hasAcceptedHunks: () => session.hasAcceptedHunks(),
      onModeChange: async (nextMode, proposalContent) => {
        if (proposalContent !== undefined) {
          session.updateDraft(change.id, proposalContent);
          if (session.isDirty(change.id)) {
            await this.runMutation(() => this.options.operations.save(session, change.id));
            if (session.isDirty(change.id)) return;
          }
        }
        const currentReview = session.snapshot();
        const currentChange = currentReview.changes.find(
          (candidate) => candidate.id === change.id,
        );
        if (currentChange === undefined) return;
        await this.open(currentReview, currentChange, nextMode);
      },
      onDecideHunk: async (proposalContent, hunkIndex, decision) => {
        return this.runMutation(async () => {
          session.updateDraft(change.id, proposalContent);
          const result = await this.options.operations.decide(session, {
            changeId: change.id,
            hunkIndex,
            decision,
          });
          if (result === null) return null;
          return {
            proposalContent: session.proposal(change.id),
            hunkIndex: result.hunkIndex,
          };
        });
      },
      onApprove: async (proposalContent) => {
        return this.runMutation(async () => {
          session.updateDraft(change.id, proposalContent);
          return (await this.options.operations.approve(session)) !== null;
        });
      },
      onSubmitAccepted: async (proposalContent) => {
        return this.runMutation(async () => {
          session.updateDraft(change.id, proposalContent);
          return (await this.options.operations.submitAccepted(session)) !== null;
        });
      },
    };
    const pair = await this.options.createPair(request);
    if (generation !== this.generation) {
      pair.close();
      return;
    }
    this.active = {
      reviewId: review.id,
      changeId: change.id,
      mode,
      key,
      pair,
      session,
      revision: review.revision,
    };
    await pair.reveal();
    pair.focusHunk(0);
  }

  public async refresh(review: Review): Promise<boolean> {
    const active = this.active;
    if (active === null || active.reviewId !== review.id) return false;
    if (this.mutationDepth > 0) return false;
    if (review.revision <= active.revision) return true;
    if (active.pair.isDirty?.() === true || active.session.hasDirtyDrafts()) return false;
    if (review.status !== "pending" && review.status !== "conflicted") {
      this.closeApproved(review.id);
      return true;
    }
    const change = review.changes.find((candidate) => candidate.id === active.changeId);
    if (change === undefined || change.proposalContent === null) {
      this.closeApproved(review.id);
      return true;
    }
    await this.open(review, change, active.mode);
    return true;
  }

  public noteReview(review: Review): void {
    if (
      this.active?.reviewId === review.id &&
      this.active.session.snapshot().revision === review.revision
    ) {
      this.active.revision = review.revision;
    }
  }

  public focusHunk(index: number): void {
    this.active?.pair.focusHunk(index);
  }

  public activeReviewId(): string | null {
    return this.active?.reviewId ?? null;
  }

  public closeApproved(reviewId: string): void {
    if (this.active?.reviewId !== reviewId) return;
    this.generation += 1;
    this.disposeActive();
  }

  public close(): void {
    this.generation += 1;
    this.disposeActive();
  }

  private disposeActive(): void {
    this.active?.pair.close();
    this.active = null;
  }

  private async runMutation<T>(action: () => Promise<T>): Promise<T> {
    this.mutationDepth += 1;
    try {
      return await action();
    } finally {
      this.mutationDepth -= 1;
    }
  }
}
