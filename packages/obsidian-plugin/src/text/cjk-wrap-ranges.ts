const cjkWordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
const cjkText =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const maximumWrapLength = 6;
const trailingAffixes = "页键期时者";
const clauseEndings = "的地得";
const leadingConnectives = "和与及或并但而";
const maximumLeadingConnectiveLength = 9;

export interface TextRange {
  readonly from: number;
  readonly to: number;
}

interface CjkSegment extends TextRange {
  readonly length: number;
  readonly text: string;
}

export function findCjkWrapRanges(text: string): readonly TextRange[] {
  const ranges: TextRange[] = [];
  const run: CjkSegment[] = [];
  const flushRun = (): void => {
    ranges.push(...rangesForRun(run));
    run.length = 0;
  };

  for (const segment of cjkWordSegmenter.segment(text)) {
    const length = segment.segment.length;
    if (
      segment.isWordLike !== true ||
      !cjkText.test(segment.segment) ||
      length > maximumWrapLength
    ) {
      flushRun();
      continue;
    }
    const previous = run[run.length - 1];
    if (previous !== undefined && previous.to !== segment.index) flushRun();
    run.push({
      from: segment.index,
      to: segment.index + length,
      length,
      text: segment.segment,
    });
    if (length === 1 && clauseEndings.includes(segment.segment)) flushRun();
  }
  flushRun();
  return ranges;
}

function rangesForRun(segments: readonly CjkSegment[]): readonly TextRange[] {
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];
  const totalLength = segments.reduce((total, segment) => total + segment.length, 0);
  if (
    firstSegment !== undefined &&
    lastSegment !== undefined &&
    firstSegment.length === 1 &&
    leadingConnectives.includes(firstSegment.text) &&
    totalLength <= maximumLeadingConnectiveLength
  ) {
    return [{ from: firstSegment.from, to: lastSegment.to }];
  }

  const ranges: TextRange[] = [];
  let cursor = segments.length;
  while (cursor > 0) {
    let start = cursor;
    let length = 0;
    while (start > 0) {
      const segment = segments[start - 1];
      if (segment === undefined) break;
      const wrapLengthLimit =
        segment.length === 1 && leadingConnectives.includes(segment.text)
          ? maximumWrapLength + 1
          : maximumWrapLength;
      if (length + segment.length > wrapLengthLimit) break;
      const preceding = segments[start - 2];
      if (
        length > 1 &&
        segment.length === 1 &&
        trailingAffixes.includes(segment.text) &&
        preceding !== undefined &&
        length + segment.length + preceding.length > maximumWrapLength
      ) {
        break;
      }
      length += segment.length;
      start -= 1;
    }
    const remaining = segments.slice(0, start).reduce((total, segment) => total + segment.length, 0);
    if (remaining === 1 && cursor - start > 1) {
      const moved = segments[start];
      if (moved !== undefined) {
        length -= moved.length;
        start += 1;
      }
    }
    const first = segments[start];
    const last = segments[cursor - 1];
    if (first === undefined || last === undefined) break;
    if (length > 1) ranges.push({ from: first.from, to: last.to });
    cursor = start;
  }
  return ranges.reverse();
}
