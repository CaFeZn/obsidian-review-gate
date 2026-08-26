import type { Range, Text } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { JsDiffEngine } from "../../../core/src/diff/jsdiff-engine";
import type { DiffHunk, DiffLine, InlineFragment } from "../../../core/src/diff/types";
import {
  nativeChangedLines,
  nativeHunkLabel,
  type NativeDiffSide,
} from "./native-diff-plan";
import { buildNativeAlignmentSpacerDecoration } from "./native-diff-alignment-widget";
import { buildNativeCjkWordDecorations } from "./native-cjk-word-decorations";
import type { TextRange } from "../text/cjk-wrap-ranges";

const diffEngine = new JsDiffEngine();
const shortCjkPhrase =
  /^[\p{Punctuation}]?[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{1,4}[\p{Punctuation}]?$/u;
const cjkCharacter =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const leadingPhraseConnector = "，、；：";
const precedingCjkCharacterLimit = 3;
const openingPunctuation = "“‘（《「『【〔〖〈";
const closingPunctuation = "”’）》」』】〕〗〉，。！？、；：…";

interface NativeDiffDecorationRequest {
  readonly base: string;
  readonly proposal: string;
  readonly side: NativeDiffSide;
}

interface NativeDiffDecorationContext {
  readonly ranges: Range<Decoration>[];
  readonly cjkExclusions: TextRange[];
  readonly documentValue: Text;
  readonly side: NativeDiffSide;
}

interface NativeChangedLineDecoration {
  readonly hunk: DiffHunk;
  readonly line: DiffLine;
  readonly first: boolean;
  readonly last: boolean;
}

export function buildNativeDiffDecorations(
  documentValue: Text,
  request: NativeDiffDecorationRequest,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const context: NativeDiffDecorationContext = {
    ranges,
    cjkExclusions: [],
    documentValue,
    side: request.side,
  };
  for (const hunk of diffEngine.diff(request.base, request.proposal, { contextLines: 0 }).hunks) {
    const baseLines = nativeChangedLines(hunk, "base");
    const proposalLines = nativeChangedLines(hunk, "proposal");
    const lines = request.side === "base" ? baseLines : proposalLines;
    const otherLines = request.side === "base" ? proposalLines : baseLines;
    const spacerLines = Math.max(0, otherLines.length - lines.length);
    if (lines.length === 0) {
      if (spacerLines === 0) {
        addAnchorDecoration(context, hunk);
      } else {
        ranges.push(
          buildNativeAlignmentSpacerDecoration({
            documentValue,
            side: request.side,
            hunk,
            changedLines: lines,
            spacerLines,
          }),
        );
      }
      continue;
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      addChangedLineDecoration(
        context,
        {
          hunk,
          line,
          first: index === 0,
          last: index === lines.length - 1 && spacerLines === 0,
        },
      );
    }
    if (spacerLines > 0) {
      ranges.push(
        buildNativeAlignmentSpacerDecoration({
          documentValue,
          side: request.side,
          hunk,
          changedLines: lines,
          spacerLines,
        }),
      );
    }
  }
  ranges.push(...buildNativeCjkWordDecorations(documentValue, context.cjkExclusions));
  return Decoration.set(ranges, true);
}

function addChangedLineDecoration(
  context: NativeDiffDecorationContext,
  change: NativeChangedLineDecoration,
): void {
  const lineNumber = context.side === "base" ? change.line.oldLine : change.line.newLine;
  if (lineNumber === null || lineNumber > context.documentValue.lines) return;
  const documentLine = context.documentValue.line(lineNumber);
  const classes = [
    context.side === "base" ? "obsreview-cm-line-remove" : "obsreview-cm-line-add",
  ];
  if (change.first) classes.push("obsreview-native-hunk-start");
  if (change.last) classes.push("obsreview-native-hunk-end");
  const attributes: Record<string, string> = { class: classes.join(" ") };
  if (change.first) attributes["data-obsreview-hunk"] = nativeHunkLabel(change.hunk);
  context.ranges.push(Decoration.line({ attributes }).range(documentLine.from));
  addInlineDecorations(
    context,
    documentLine,
    context.side === "base" ? change.line.oldInline : change.line.newInline,
  );
}

function addAnchorDecoration(
  context: NativeDiffDecorationContext,
  hunk: DiffHunk,
): void {
  const requested = context.side === "base" ? hunk.oldStart : hunk.newStart;
  const line = context.documentValue.line(
    Math.min(context.documentValue.lines, Math.max(1, requested)),
  );
  context.ranges.push(
    Decoration.line({
      attributes: {
        class: "obsreview-native-hunk-anchor obsreview-native-hunk-start obsreview-native-hunk-end",
        "data-obsreview-hunk": nativeHunkLabel(hunk),
      },
    }).range(line.from),
  );
}

function addInlineDecorations(
  context: NativeDiffDecorationContext,
  documentLine: { readonly from: number; readonly to: number },
  fragments: readonly InlineFragment[] | undefined,
): void {
  if (fragments === undefined) return;
  const changedKind = context.side === "base" ? "remove" : "add";
  const lineText = context.documentValue.sliceString(documentLine.from, documentLine.to);
  let offset = 0;
  for (const fragment of fragments) {
    const start = documentLine.from + offset;
    const end = Math.min(documentLine.to, start + fragment.text.length);
    if (fragment.kind === changedKind && end > start) {
      let trailingPhrase: { readonly start: number; readonly end: number } | undefined;
      if (shortCjkPhrase.test(fragment.text)) {
        let phraseStart = offset;
        let phraseEnd = offset + fragment.text.length;
        while (
          phraseEnd < lineText.length &&
          closingPunctuation.includes(lineText[phraseEnd] ?? "")
        ) {
          phraseEnd += 1;
        }
        if (leadingPhraseConnector.includes(fragment.text[0] ?? "")) {
          let precedingCjkCharacters = 0;
          while (
            phraseStart > 0 &&
            precedingCjkCharacters < precedingCjkCharacterLimit &&
            cjkCharacter.test(lineText[phraseStart - 1] ?? "")
          ) {
            phraseStart -= 1;
            precedingCjkCharacters += 1;
          }
          if (phraseStart < offset) {
            addInlinePhraseDecoration(
              context,
              documentLine.from + phraseStart,
              documentLine.from + offset + 1,
            );
          }
          trailingPhrase = { start: offset + 1, end: phraseEnd };
        } else {
          while (
            phraseStart > 0 &&
            openingPunctuation.includes(lineText[phraseStart - 1] ?? "")
          ) {
            phraseStart -= 1;
          }
          addInlinePhraseDecoration(
            context,
            documentLine.from + phraseStart,
            documentLine.from + phraseEnd,
          );
        }
      }
      context.ranges.push(
        Decoration.mark({
          class:
            context.side === "base"
              ? "obsreview-cm-inline-remove"
              : "obsreview-cm-inline-add",
        }).range(start, end),
      );
      if (trailingPhrase !== undefined && trailingPhrase.end > trailingPhrase.start) {
        addInlinePhraseDecoration(
          context,
          documentLine.from + trailingPhrase.start,
          documentLine.from + trailingPhrase.end,
        );
      }
    }
    offset += fragment.text.length;
  }
}

function addInlinePhraseDecoration(
  context: NativeDiffDecorationContext,
  from: number,
  to: number,
): void {
  context.cjkExclusions.push({ from, to });
  context.ranges.push(
    Decoration.mark({ class: "obsreview-cm-inline-phrase" }).range(from, to),
  );
}
