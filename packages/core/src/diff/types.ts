export type DiffLineKind = "context" | "add" | "remove";
export type InlineKind = "equal" | "add" | "remove";

export interface InlineFragment {
  readonly kind: InlineKind;
  readonly text: string;
}

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly oldInline?: readonly InlineFragment[];
  readonly newInline?: readonly InlineFragment[];
}

export interface DiffHunk {
  readonly id: string;
  /** 1-based display position, matching unified diff conventions. */
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;

  /** Exact mutable proposal interval used by reject-hunk. */
  readonly baseStartIndex: number;
  readonly baseLineCount: number;
  readonly proposalStartIndex: number;
  readonly proposalLineCount: number;
  readonly baseSegment: string;
  readonly proposalSegment: string;

  readonly lines: readonly DiffLine[];
}

export interface DiffStats {
  readonly addedLines: number;
  readonly removedLines: number;
  readonly hunkCount: number;
}

export interface DiffResult {
  readonly baseHash: string;
  readonly proposalHash: string;
  readonly hunks: readonly DiffHunk[];
  readonly stats: DiffStats;
}

export interface DiffOptions {
  readonly contextLines?: number;
  readonly timeoutMs?: number;
  readonly maxEditLength?: number;
}

export interface DiffEngine {
  diff(base: string, proposal: string, options?: DiffOptions): DiffResult;
}
