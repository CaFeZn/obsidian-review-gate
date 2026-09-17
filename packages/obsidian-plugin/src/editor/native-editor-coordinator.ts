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
}

interface NativeEditorCoordinatorOptions {
  readonly service: ReviewSessionService;
  readonly operations: NativeReviewOperations;
  readonly createPair: (request: NativeEditorPairRequest) => Promise<NativeEditorPair>;
}

interface ActiveEditorSession {
  readonly reviewId: string;
  readonly key: string;
  readonly pair: NativeEditorPair;
}

export class NativeEditorCoordinator {
  private generation = 0;
  private active: ActiveEditorSession | null = null;

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
        session.updateDraft(change.id, proposalContent);
        if (!session.isDirty(change.id)) return;
        await this.options.operations.save(session, change.id);
      },
      onModeChange: async (nextMode, proposalContent) => {
        if (proposalContent !== undefined) {
          session.updateDraft(change.id, proposalContent);
          if (session.isDirty(change.id)) {
            await this.options.operations.save(session, change.id);
          }
        }
        await this.open(review, change, nextMode);
      },
      onDecideHunk: async (proposalContent, hunkIndex, decision) => {
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
      },
      onApprove: async (proposalContent) => {
        session.updateDraft(change.id, proposalContent);
        return (await this.options.operations.approve(session)) !== null;
      },
    };
    const pair = await this.options.createPair(request);
    if (generation !== this.generation) {
      pair.close();
      return;
    }
    this.active = { reviewId: review.id, key, pair };
    await pair.reveal();
    pair.focusHunk(0);
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
}
