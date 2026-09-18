import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  type DecorationSet,
} from "@codemirror/view";
import { buildNativeDiffDecorations } from "./native-diff-decoration-builder";
import type { NativeDiffSide } from "./native-diff-plan";
import type { NativeScrollContainer } from "./native-scroll-sync";

export interface NativeCodeMirrorEditor {
  readonly scrollDOM: NativeScrollContainer;
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
  focus(): void;
}

export interface NativeDiffEditorBinding {
  destroy(): void;
}

interface NativeDiffSession {
  readonly side: NativeDiffSide;
  readonly base: string;
  readonly baseEditor: NativeCodeMirrorEditor;
  readonly proposalEditor: NativeCodeMirrorEditor;
  activeHunkLabel: string | null;
}

const sessions = new WeakMap<NativeCodeMirrorEditor, NativeDiffSession>();
const stateSessions = new WeakMap<EditorState, NativeDiffSession>();
const refreshNativeDiff = StateEffect.define<null>();
export const setNativeActiveHunk = StateEffect.define<string | null>();
const protectNativeBase = EditorState.transactionFilter.of((transaction) => {
  const session = stateSessions.get(transaction.startState);
  return session?.side === "base" && transaction.docChanged ? [] : transaction;
});
const nativeDiffDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    const session = stateSessions.get(transaction.startState);
    const refreshRequested = transaction.effects.some((effect) =>
      effect.is(refreshNativeDiff),
    );
    const activeHunkEffect = transaction.effects.find((effect) =>
      effect.is(setNativeActiveHunk),
    );
    if (session === undefined) {
      return refreshRequested || activeHunkEffect !== undefined
        ? Decoration.none
        : decorations.map(transaction.changes);
    }
    stateSessions.set(transaction.state, session);
    if (activeHunkEffect !== undefined) {
      session.activeHunkLabel = activeHunkEffect.value;
    }
    if (!transaction.docChanged && !refreshRequested && activeHunkEffect === undefined) {
      return decorations;
    }
    return decorationsForState(transaction.state, session);
  },
  provide: (field) => EditorView.decorations.from(field),
});
const refreshNativePeer = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  const session = sessions.get(update.view);
  if (session?.side === "proposal") refreshEditor(session.baseEditor);
});

export const nativeDiffEditorExtension: Extension = [
  protectNativeBase,
  nativeDiffDecorationField,
  refreshNativePeer,
];

export function bindNativeDiffEditors(
  baseEditor: NativeCodeMirrorEditor,
  proposalEditor: NativeCodeMirrorEditor,
  base: string,
): NativeDiffEditorBinding {
  const shared = { base, baseEditor, proposalEditor };
  const baseSession: NativeDiffSession = {
    ...shared,
    side: "base",
    activeHunkLabel: null,
  };
  const proposalSession: NativeDiffSession = {
    ...shared,
    side: "proposal",
    activeHunkLabel: null,
  };
  sessions.set(baseEditor, baseSession);
  sessions.set(proposalEditor, proposalSession);
  stateSessions.set(baseEditor.state, baseSession);
  stateSessions.set(proposalEditor.state, proposalSession);
  refreshEditor(baseEditor);
  refreshEditor(proposalEditor);
  let active = true;
  return {
    destroy: () => {
      if (!active) return;
      active = false;
      sessions.delete(baseEditor);
      sessions.delete(proposalEditor);
      stateSessions.delete(baseEditor.state);
      stateSessions.delete(proposalEditor.state);
      refreshEditor(baseEditor);
      refreshEditor(proposalEditor);
    },
  };
}

function decorationsForState(
  state: EditorState,
  session: NativeDiffSession,
): DecorationSet {
  return buildNativeDiffDecorations(state.doc, {
    base: session.base,
    proposal:
      session.side === "proposal"
        ? state.doc.toString()
        : session.proposalEditor.state.doc.toString(),
    side: session.side,
    activeHunkLabel: session.activeHunkLabel,
  });
}

function refreshEditor(editor: NativeCodeMirrorEditor): void {
  editor.dispatch({ effects: refreshNativeDiff.of(null) });
}
