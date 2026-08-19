import { JsDiffEngine } from "../../../core/src/diff/jsdiff-engine";
import type { DiffLine, InlineFragment } from "../../../core/src/diff/types";

/**
 * CodeMirror 6 compatibility layer.
 *
 * Obsidian exposes the public @codemirror/state and @codemirror/view packages
 * to desktop plugins. We deliberately avoid private Obsidian editor internals
 * and avoid @codemirror/merge as a runtime dependency: the review page owns
 * hunk decisions, while this modal provides a normal editable proposal editor
 * with public-CM6 line and inline decorations.
 *
 * The dynamic boundary keeps the portable source/test build independent of an
 * installed Obsidian SDK. If CM6 is unavailable, the caller falls back to a
 * textarea without weakening the Review Gate's target-write invariants.
 */

export interface MergeEditorController {
  getProposal(): string;
  destroy(): void;
}

export type MergeEditorMode = "split" | "unified";

type DecorationSide = "base" | "proposal";

const diffEngine = new JsDiffEngine();
const MAX_DECORATED_TEXT_LENGTH = 1_000_000;

export function tryCreateMergeEditor(
  parent: HTMLElement,
  base: string,
  proposal: string,
  mode: MergeEditorMode,
  onChange: (proposal: string) => void,
): MergeEditorController | null {
  try {
    const stateModule = require("@codemirror/state") as DynamicStateModule;
    const viewModule = require("@codemirror/view") as DynamicViewModule;

    parent.classList.add("obsreview-cm6-host", `is-${mode}`);
    if (mode === "split") {
      return createSplitEditor(parent, base, proposal, onChange, stateModule, viewModule);
    }
    return createUnifiedEditor(parent, base, proposal, onChange, stateModule, viewModule);
  } catch {
    parent.empty?.();
    parent.classList.remove("obsreview-cm6-host", "is-split", "is-unified");
    return null;
  }
}

function createSplitEditor(
  parent: HTMLElement,
  base: string,
  proposal: string,
  onChange: (proposal: string) => void,
  stateModule: DynamicStateModule,
  viewModule: DynamicViewModule,
): MergeEditorController {
  const split = document.createElement("div");
  split.className = "obsreview-cm6-split";
  parent.appendChild(split);
  const baseHost = createPane(split, "Current / Base", "is-base");
  const proposalHost = createPane(split, "Proposal", "is-proposal");

  const refreshBaseDecorations = stateModule.StateEffect.define<DynamicDecorationSet>();
  const baseDecorationField = stateModule.StateField.define<DynamicDecorationSet>({
    create: (state) =>
      buildDecorations(
        state.doc,
        base,
        proposal,
        "base",
        viewModule.Decoration,
      ),
    update: (value, transaction) => {
      for (const effect of transaction.effects) {
        if (effect.is(refreshBaseDecorations)) return effect.value;
      }
      return value;
    },
    provide: (field) => viewModule.EditorView.decorations.from(field),
  });
  const proposalDecorationField = createProposalDecorationField(
    base,
    stateModule,
    viewModule,
  );

  const baseState = stateModule.EditorState.create({
    doc: base,
    extensions: [
      stateModule.EditorState.readOnly.of(true),
      viewModule.EditorView.editable.of(false),
      viewModule.EditorView.lineWrapping,
      baseDecorationField,
    ],
  });
  const baseView = new viewModule.EditorView({ state: baseState, parent: baseHost });

  const listener = viewModule.EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const nextProposal = update.state.doc.toString();
    onChange(nextProposal);
    const decorations = buildDecorations(
      baseView.state.doc,
      base,
      nextProposal,
      "base",
      viewModule.Decoration,
    );
    baseView.dispatch({ effects: refreshBaseDecorations.of(decorations) });
  });
  const proposalState = stateModule.EditorState.create({
    doc: proposal,
    extensions: [
      listener,
      viewModule.EditorView.lineWrapping,
      proposalDecorationField,
    ],
  });
  const proposalView = new viewModule.EditorView({
    state: proposalState,
    parent: proposalHost,
  });

  return {
    getProposal: () => proposalView.state.doc.toString(),
    destroy: () => {
      baseView.destroy();
      proposalView.destroy();
      split.remove();
    },
  };
}

function createUnifiedEditor(
  parent: HTMLElement,
  base: string,
  proposal: string,
  onChange: (proposal: string) => void,
  stateModule: DynamicStateModule,
  viewModule: DynamicViewModule,
): MergeEditorController {
  const unifiedHost = createPane(parent, "Editable proposal", "is-unified");
  const proposalDecorationField = createProposalDecorationField(
    base,
    stateModule,
    viewModule,
  );
  const listener = viewModule.EditorView.updateListener.of((update) => {
    if (update.docChanged) onChange(update.state.doc.toString());
  });
  const state = stateModule.EditorState.create({
    doc: proposal,
    extensions: [listener, viewModule.EditorView.lineWrapping, proposalDecorationField],
  });
  const view = new viewModule.EditorView({ state, parent: unifiedHost });
  return {
    getProposal: () => view.state.doc.toString(),
    destroy: () => {
      view.destroy();
      unifiedHost.parentElement?.remove();
    },
  };
}

function createProposalDecorationField(
  base: string,
  stateModule: DynamicStateModule,
  viewModule: DynamicViewModule,
): unknown {
  return stateModule.StateField.define<DynamicDecorationSet>({
    create: (state) =>
      buildDecorations(
        state.doc,
        base,
        state.doc.toString(),
        "proposal",
        viewModule.Decoration,
      ),
    update: (value, transaction) =>
      transaction.docChanged
        ? buildDecorations(
            transaction.state.doc,
            base,
            transaction.state.doc.toString(),
            "proposal",
            viewModule.Decoration,
          )
        : value,
    provide: (field) => viewModule.EditorView.decorations.from(field),
  });
}

function buildDecorations(
  documentValue: DynamicDocument,
  base: string,
  proposal: string,
  side: DecorationSide,
  decorationModule: DynamicDecorationModule,
): DynamicDecorationSet {
  if (base.length + proposal.length > MAX_DECORATED_TEXT_LENGTH) {
    return decorationModule.none;
  }

  try {
    const result = diffEngine.diff(base, proposal, {
      contextLines: 0,
      timeoutMs: 500,
      maxEditLength: 20_000,
    });
    const ranges: DynamicDecorationRange[] = [];
    for (const hunk of result.hunks) {
      for (const line of hunk.lines) {
        addLineDecorations(ranges, documentValue, line, side, decorationModule);
      }
    }
    return decorationModule.set(ranges, true);
  } catch {
    return decorationModule.none;
  }
}

function addLineDecorations(
  ranges: DynamicDecorationRange[],
  documentValue: DynamicDocument,
  line: DiffLine,
  side: DecorationSide,
  decorationModule: DynamicDecorationModule,
): void {
  const lineNumber = side === "base" ? line.oldLine : line.newLine;
  const kind = side === "base" ? "remove" : "add";
  if (lineNumber === null || line.kind !== kind || lineNumber > documentValue.lines) return;

  const documentLine = documentValue.line(lineNumber);
  const lineClass = side === "base" ? "obsreview-cm-line-remove" : "obsreview-cm-line-add";
  ranges.push(
    decorationModule.line({ attributes: { class: lineClass } }).range(documentLine.from),
  );

  const fragments = side === "base" ? line.oldInline : line.newInline;
  if (fragments === undefined) return;
  addInlineDecorations(
    ranges,
    documentLine,
    fragments,
    side,
    decorationModule,
  );
}

function addInlineDecorations(
  ranges: DynamicDecorationRange[],
  documentLine: DynamicDocumentLine,
  fragments: readonly InlineFragment[],
  side: DecorationSide,
  decorationModule: DynamicDecorationModule,
): void {
  let offset = 0;
  const changedKind = side === "base" ? "remove" : "add";
  const inlineClass =
    side === "base" ? "obsreview-cm-inline-remove" : "obsreview-cm-inline-add";
  for (const fragment of fragments) {
    const start = documentLine.from + offset;
    const end = Math.min(documentLine.to, start + fragment.text.length);
    if (fragment.kind === changedKind && end > start) {
      ranges.push(decorationModule.mark({ class: inlineClass }).range(start, end));
    }
    offset += fragment.text.length;
  }
}

function createPane(
  parent: HTMLElement,
  title: string,
  className: string,
): HTMLElement {
  const pane = document.createElement("section");
  pane.className = `obsreview-cm6-pane ${className}`;
  const heading = document.createElement("div");
  heading.className = "obsreview-cm6-pane-title";
  heading.textContent = title;
  const editor = document.createElement("div");
  editor.className = "obsreview-cm6-editor";
  pane.append(heading, editor);
  parent.appendChild(pane);
  return editor;
}

interface DynamicDocumentLine {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

interface DynamicDocument {
  readonly lines: number;
  toString(): string;
  line(number: number): DynamicDocumentLine;
}

interface DynamicState {
  readonly doc: DynamicDocument;
}

interface DynamicStateEffectType<T> {
  of(value: T): DynamicStateEffect<T>;
}

interface DynamicStateEffect<T> {
  readonly value: T;
  is(type: DynamicStateEffectType<T>): boolean;
}

interface DynamicTransaction {
  readonly docChanged: boolean;
  readonly state: DynamicState;
  readonly effects: readonly DynamicStateEffect<DynamicDecorationSet>[];
}

interface DynamicUpdate {
  readonly docChanged: boolean;
  readonly state: DynamicState;
}

interface DynamicEditorViewInstance {
  readonly state: DynamicState;
  dispatch(spec: { effects: DynamicStateEffect<DynamicDecorationSet> }): void;
  destroy(): void;
}

interface DynamicDecorationRange {
  readonly from: number;
  readonly to: number;
}

interface DynamicDecoration {
  range(from: number, to?: number): DynamicDecorationRange;
}

interface DynamicDecorationSet {
  readonly size?: number;
}

interface DynamicDecorationModule {
  readonly none: DynamicDecorationSet;
  line(spec: { attributes: { class: string } }): DynamicDecoration;
  mark(spec: { class: string }): DynamicDecoration;
  set(
    ranges: readonly DynamicDecorationRange[],
    sort?: boolean,
  ): DynamicDecorationSet;
}

interface DynamicViewModule {
  readonly Decoration: DynamicDecorationModule;
  readonly EditorView: {
    new (config: { state: DynamicState; parent: HTMLElement }): DynamicEditorViewInstance;
    readonly updateListener: {
      of(listener: (update: DynamicUpdate) => void): unknown;
    };
    readonly lineWrapping: unknown;
    readonly editable: { of(value: boolean): unknown };
    readonly decorations: { from(field: unknown): unknown };
  };
}

interface DynamicStateFieldDefinition<T> {
  create(state: DynamicState): T;
  update(value: T, transaction: DynamicTransaction): T;
  provide(field: unknown): unknown;
}

interface DynamicStateModule {
  readonly EditorState: {
    readonly readOnly: { of(value: boolean): unknown };
    create(config: { doc: string; extensions: readonly unknown[] }): DynamicState;
  };
  readonly StateEffect: {
    define<T>(): DynamicStateEffectType<T>;
  };
  readonly StateField: {
    define<T>(definition: DynamicStateFieldDefinition<T>): unknown;
  };
}
