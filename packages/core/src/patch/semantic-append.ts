export interface SemanticAppendSpec {
  readonly anchor: string;
  readonly content: string;
  readonly action?: "append" | "remove";
}

export type SemanticAppendFailureReason =
  | "anchor-not-found"
  | "anchor-ambiguous"
  | "content-already-present"
  | "content-not-found"
  | "content-ambiguous";

export interface SemanticAppendSuccess {
  readonly ok: true;
  readonly content: string;
}

export interface SemanticAppendFailure {
  readonly ok: false;
  readonly reason: SemanticAppendFailureReason;
}

export type SemanticAppendResult = SemanticAppendSuccess | SemanticAppendFailure;

/** Applies either the forward append event or its compensating removal. */
export function materializeSemanticAppend(
  document: string,
  spec: SemanticAppendSpec,
): SemanticAppendResult {
  return spec.action === "remove"
    ? removeSemanticAppend(document, spec)
    : applySemanticAppend(document, spec);
}

/**
 * Appends one semantic fragment to the Markdown section identified by an exact
 * anchor line. For Markdown headings, the fragment is placed at the end of that
 * section and before the next heading of the same or higher level.
 */
export function applySemanticAppend(
  document: string,
  spec: SemanticAppendSpec,
): SemanticAppendResult {
  const region = findAnchorRegion(document, spec.anchor);
  if (!region.ok) return region;
  const fragment = normalizeFragment(spec.content, region.lineEnding);
  if (fragment.length === 0) return { ok: true, content: document };
  const occurrences = countOccurrences(document.slice(region.bodyStart, region.bodyEnd), fragment);
  if (occurrences > 0) return { ok: false, reason: "content-already-present" };

  const before = document.slice(0, region.insertionOffset);
  const after = document.slice(region.insertionOffset);
  const separator = before.length > 0 && !endsWithLineEnding(before) ? region.lineEnding : "";
  return { ok: true, content: `${before}${separator}${fragment}${after}` };
}

/** Removes exactly one previously appended fragment without touching siblings. */
export function removeSemanticAppend(
  document: string,
  spec: SemanticAppendSpec,
): SemanticAppendResult {
  const region = findAnchorRegion(document, spec.anchor);
  if (!region.ok) return region;
  const fragment = normalizeFragment(spec.content, region.lineEnding);
  const section = document.slice(region.bodyStart, region.bodyEnd);
  const occurrences = countOccurrences(section, fragment);
  if (occurrences === 0) return { ok: false, reason: "content-not-found" };
  if (occurrences > 1) return { ok: false, reason: "content-ambiguous" };
  const relative = section.indexOf(fragment);
  const start = region.bodyStart + relative;
  return {
    ok: true,
    content: document.slice(0, start) + document.slice(start + fragment.length),
  };
}

interface AnchorRegionSuccess {
  readonly ok: true;
  readonly lineEnding: "\n" | "\r\n";
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly insertionOffset: number;
}

type AnchorRegionResult =
  | AnchorRegionSuccess
  | { readonly ok: false; readonly reason: "anchor-not-found" | "anchor-ambiguous" };

function findAnchorRegion(document: string, anchor: string): AnchorRegionResult {
  const lineEnding = document.includes("\r\n") ? "\r\n" : "\n";
  const lines = document.split(lineEnding);
  const matches: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === anchor) matches.push(index);
  }
  if (matches.length === 0) return { ok: false, reason: "anchor-not-found" };
  if (matches.length > 1) return { ok: false, reason: "anchor-ambiguous" };

  const anchorIndex = matches[0] as number;
  const heading = /^(#{1,6})\s+/u.exec(anchor);
  let sectionEnd = lines.length;
  if (heading !== null) {
    const level = heading[1]?.length ?? 6;
    for (let index = anchorIndex + 1; index < lines.length; index += 1) {
      const candidate = /^(#{1,6})\s+/u.exec(lines[index] ?? "");
      if (candidate !== null && (candidate[1]?.length ?? 7) <= level) {
        sectionEnd = index;
        break;
      }
    }
  } else {
    sectionEnd = Math.min(lines.length, anchorIndex + 1);
  }

  const offsets = lineOffsets(lines, lineEnding);
  const bodyStart = offsets[Math.min(anchorIndex + 1, lines.length)] ?? document.length;
  const bodyEnd = offsets[sectionEnd] ?? document.length;
  let insertionIndex = sectionEnd;
  const hasBodyContent = lines
    .slice(anchorIndex + 1, sectionEnd)
    .some((line) => line.trim().length > 0);
  if (hasBodyContent) {
    while (insertionIndex > anchorIndex + 1 && (lines[insertionIndex - 1] ?? "").trim().length === 0) {
      insertionIndex -= 1;
    }
  }
  return {
    ok: true,
    lineEnding,
    bodyStart,
    bodyEnd,
    insertionOffset: offsets[insertionIndex] ?? document.length,
  };
}

function lineOffsets(lines: readonly string[], lineEnding: string): readonly number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    offsets.push(offset);
    offset += (lines[index]?.length ?? 0) + (index < lines.length - 1 ? lineEnding.length : 0);
  }
  offsets.push(offset);
  return offsets;
}

function normalizeFragment(content: string, lineEnding: "\n" | "\r\n"): string {
  const normalized = content.replace(/\r\n|\r|\n/gu, "\n");
  if (normalized.length === 0) return "";
  const withEnding = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  return lineEnding === "\n" ? withEnding : withEnding.replace(/\n/gu, "\r\n");
}

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function endsWithLineEnding(value: string): boolean {
  return value.endsWith("\n") || value.endsWith("\r");
}
