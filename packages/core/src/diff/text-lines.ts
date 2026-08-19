export function splitLinesPreserveEndings(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 10) {
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    } else if (char === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      lines.push(text.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function stripLineEnding(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/u, "");
}

export function detectPreferredEol(text: string): "\r\n" | "\n" | "\r" | "" {
  const match = /\r\n|\n|\r/u.exec(text);
  return (match?.[0] as "\r\n" | "\n" | "\r" | undefined) ?? "";
}
