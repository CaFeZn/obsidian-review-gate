import { myersDiff } from "../vendor/jsdiff/myers";
import type { InlineFragment } from "./types";

export interface InlinePair {
  readonly oldFragments: readonly InlineFragment[];
  readonly newFragments: readonly InlineFragment[];
}

export function diffInline(oldText: string, newText: string): InlinePair {
  const oldTokens = tokenizeInline(oldText);
  const newTokens = tokenizeInline(newText);
  const components = myersDiff(oldTokens, newTokens, { timeoutMs: 100 }) ?? [
    { added: false, removed: true, values: oldTokens },
    { added: true, removed: false, values: newTokens },
  ];

  const oldFragments: InlineFragment[] = [];
  const newFragments: InlineFragment[] = [];
  for (const component of components) {
    const text = component.values.join("");
    if (text.length === 0) continue;
    if (component.removed) {
      oldFragments.push({ kind: "remove", text });
    } else if (component.added) {
      newFragments.push({ kind: "add", text });
    } else {
      const fragment: InlineFragment = { kind: "equal", text };
      oldFragments.push(fragment);
      newFragments.push(fragment);
    }
  }
  return { oldFragments, newFragments };
}

function tokenizeInline(text: string): readonly string[] {
  const tokens = text.match(/\s+|[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu);
  return tokens ?? (text.length === 0 ? [] : Array.from(text));
}
