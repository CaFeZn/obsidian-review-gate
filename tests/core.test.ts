import test from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  JsDiffEngine,
  ReviewError,
  applyHunkDecision,
  assertTransition,
  createChangeId,
  createReviewId,
  normalizeVaultRelativeTarget,
  rebaseChange,
  planPartialCommit,
  rebaseChangeWithCurrentPriority,
  resolveSafeTarget,
  sha256,
  type ReviewChange,
} from "../packages/core/src/index";
import { cleanupVault, createVault } from "./helpers";
import { myersDiff } from "../packages/core/src/vendor/jsdiff/myers";

test("sha256 is deterministic and standards-compatible", () => {
  assert.equal(
    sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("review and change identifiers have stable sortable shapes", () => {
  const first = createReviewId(1_700_000_000_000);
  const second = createReviewId(1_700_000_000_001);
  assert.match(first, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.ok(first < second);
  assert.equal(createChangeId(7), "0007");
});

test("state machine rejects mutation of terminal reviews", () => {
  assert.doesNotThrow(() => assertTransition("pending", "conflicted"));
  assert.throws(
    () => assertTransition("approved", "pending"),
    (error: unknown) => error instanceof ReviewError && error.code === "INVALID_STATE_TRANSITION",
  );
});

test("target normalization rejects traversal, absolute paths, drives, and storage paths", () => {
  assert.equal(normalizeVaultRelativeTarget("Framework\\CAN.md"), "Framework/CAN.md");
  for (const invalid of [
    "../outside.md",
    "Framework/../outside.md",
    "/etc/passwd",
    "C:\\Windows\\System32\\x",
    "\\\\server\\share\\x",
    ".obsreview/pending/x",
    "a//b.md",
  ]) {
    assert.throws(
      () => normalizeVaultRelativeTarget(invalid),
      (error: unknown) => error instanceof ReviewError && error.code === "INVALID_TARGET_PATH",
      invalid,
    );
  }
});

test("path validation rejects a symlink escape", async () => {
  const vault = await createVault();
  const outside = await createVault();
  try {
    await writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    await symlink(
      outside,
      path.join(vault, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      resolveSafeTarget(vault, "escape/secret.md"),
      (error: unknown) => error instanceof ReviewError && error.code === "INVALID_TARGET_PATH",
    );
  } finally {
    await cleanupVault(vault);
    await cleanupVault(outside);
  }
});

test("diff engine creates separated hunks and inline fragments", () => {
  const engine = new JsDiffEngine();
  const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
  const proposal = "one\nTWO changed\nthree\nfour\nfive\nsix\nseven\nEIGHT changed\nnine\n";
  const result = engine.diff(base, proposal, { contextLines: 1 });
  assert.equal(result.hunks.length, 2);
  assert.equal(result.stats.addedLines, 2);
  assert.equal(result.stats.removedLines, 2);
  const first = result.hunks[0];
  assert.ok(first);
  const removed = first.lines.find((line) => line.kind === "remove");
  const added = first.lines.find((line) => line.kind === "add");
  assert.ok(removed?.oldInline?.some((fragment) => fragment.kind === "remove"));
  assert.ok(added?.newInline?.some((fragment) => fragment.kind === "add"));
});

test("reject hunk mutates proposal only and accept hunk preserves proposal", () => {
  const engine = new JsDiffEngine();
  const base = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n";
  const proposal = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n";
  const initial: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {},
  };
  const diff = engine.diff(base, proposal);
  assert.equal(diff.hunks.length, 2);
  const first = diff.hunks[0];
  assert.ok(first);
  const rejected = applyHunkDecision(initial, first.id, "rejected", engine);
  assert.equal(rejected.baseContent, base);
  assert.equal(rejected.proposalContent, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n");
  const remaining = engine.diff(base, rejected.proposalContent ?? "");
  assert.equal(remaining.hunks.length, 1);
  const last = remaining.hunks[0];
  assert.ok(last);
  const accepted = applyHunkDecision(rejected, last.id, "accepted", engine);
  assert.equal(accepted.proposalContent, rejected.proposalContent);
  assert.equal(accepted.hunkDecisions[last.id]?.decision, "accepted");
});

test("create review hunks can be rejected back to an empty proposal", () => {
  const engine = new JsDiffEngine();
  const proposal = "new\nnote\n";
  const change: ReviewChange = {
    id: "0001",
    operation: "create",
    target: "new.md",
    baseHash: null,
    baseContent: null,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {},
  };
  const hunk = engine.diff("", proposal).hunks[0];
  assert.ok(hunk);
  const rejected = applyHunkDecision(change, hunk.id, "rejected", engine);
  assert.equal(rejected.proposalContent, "");
});

test("conservative rebase merges disjoint line edits", () => {
  const base = "one\ntwo\nthree\nfour\n";
  const proposal = "ONE\ntwo\nthree\nfour\n";
  const current = "one\ntwo\nthree\nFOUR\n";
  const change: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {},
  };
  const result = rebaseChange(change, current);
  assert.equal(result.clean, true);
  assert.equal(result.change?.baseContent, current);
  assert.equal(result.change?.proposalContent, "ONE\ntwo\nthree\nFOUR\n");
});

test("conservative rebase refuses overlapping edits", () => {
  const base = "one\ntwo\nthree\n";
  const change: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: "one\nPROPOSAL\nthree\n",
    proposalHash: sha256("one\nPROPOSAL\nthree\n"),
    hunkDecisions: {},
  };
  const result = rebaseChange(change, "one\nCURRENT\nthree\n");
  assert.equal(result.clean, false);
  assert.ok((result.overlappingRanges?.length ?? 0) > 0);
});

test("current-priority rebase keeps the human edit and drops the overlap", () => {
  // Given: the document was edited by hand where the proposal also changed.
  const base = "one\ntwo\nthree\n";
  const change: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: "one\nPROPOSAL\nthree\n",
    proposalHash: sha256("one\nPROPOSAL\nthree\n"),
    hunkDecisions: {},
  };

  // When: the change is reconciled with the current content taking priority.
  const reconciled = rebaseChangeWithCurrentPriority(change, "one\nCURRENT\nthree\n");

  // Then: the human content becomes both the base and the proposal, so the
  // overlapping agent edit is dropped instead of blocking the review.
  assert.equal(reconciled.baseContent, "one\nCURRENT\nthree\n");
  assert.equal(reconciled.proposalContent, "one\nCURRENT\nthree\n");
  assert.equal(reconciled.baseHash, sha256("one\nCURRENT\nthree\n"));
  assert.deepEqual(reconciled.hunkDecisions, {});
});

test("current-priority rebase still merges disjoint agent edits", () => {
  // Given: the human edit and the proposal touch different lines.
  const base = "one\ntwo\nthree\nfour\n";
  const change: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: "ONE\ntwo\nthree\nfour\n",
    proposalHash: sha256("ONE\ntwo\nthree\nfour\n"),
    hunkDecisions: {},
  };

  // When: the change is reconciled with the current content taking priority.
  const reconciled = rebaseChangeWithCurrentPriority(change, "one\ntwo\nthree\nFOUR\n");

  // Then: the current content is the new base and the agent edit survives.
  assert.equal(reconciled.baseContent, "one\ntwo\nthree\nFOUR\n");
  assert.equal(reconciled.proposalContent, "ONE\ntwo\nthree\nFOUR\n");
});

test("a partially accepted change commits only its accepted hunks", () => {
  // Given: a document with two changed regions far enough apart to stay
  // separate hunks, where only the first hunk has been accepted so far.
  const base = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((line) => `${line}\n`).join("");
  const proposal = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "K", "l"].map((line) => `${line}\n`).join("");
  const engine = new JsDiffEngine();
  const hunks = engine.diff(base, proposal).hunks;
  assert.equal(hunks.length, 2);
  const first = hunks[0];
  assert.ok(first);
  const change: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {
      [first.id]: {
        decision: "accepted",
        at: new Date().toISOString(),
        baseHash: sha256(base),
        proposalHash: sha256(proposal),
      },
    },
  };

  // When: the review is split into a now-part and a later-part.
  const plan = planPartialCommit([change], engine);

  // Then: the committed part contains only the accepted hunk.
  assert.equal(plan.commit.length, 1);
  assert.equal(
    plan.commit[0]?.proposalContent,
    ["A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((line) => `${line}\n`).join(""),
  );
  assert.deepEqual(plan.commit[0]?.hunkDecisions, {});

  // And: the remnant keeps the untouched hunk, rebased onto what was written,
  // so the next review session sees only the remaining change.
  assert.equal(plan.remnant.length, 1);
  assert.equal(
    plan.remnant[0]?.baseContent,
    ["A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((line) => `${line}\n`).join(""),
  );
  assert.equal(plan.remnant[0]?.proposalContent, proposal);
});

test("a change with no accepted hunk is left entirely for later", () => {
  // Given: a change whose only hunk is still undecided.
  const base = "one\ntwo\nthree\n";
  const proposal = "one\nTWO\nthree\n";
  const engine = new JsDiffEngine();
  const change: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {},
  };

  // When: a partial commit is planned.
  const plan = planPartialCommit([change], engine);

  // Then: nothing is committed and the change stays pending untouched.
  assert.deepEqual(plan.commit, []);
  assert.equal(plan.remnant.length, 1);
  assert.equal(plan.remnant[0]?.proposalContent, proposal);
  assert.equal(plan.remnant[0]?.baseContent, base);
});

test("a change with every hunk accepted commits whole", () => {
  // Given: a change whose hunks were all accepted.
  const base = "one\ntwo\nthree\n";
  const proposal = "one\nTWO\nthree\n";
  const engine = new JsDiffEngine();
  const hunk = engine.diff(base, proposal).hunks[0];
  assert.ok(hunk);
  const change: ReviewChange = {
    id: "0001",
    operation: "modify",
    target: "note.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {
      [hunk.id]: {
        decision: "accepted",
        at: new Date().toISOString(),
        baseHash: sha256(base),
        proposalHash: sha256(proposal),
      },
    },
  };

  // When: a partial commit is planned.
  const plan = planPartialCommit([change], engine);

  // Then: the whole change is committed and nothing is left over, so the review
  // finishes instead of staying permanently pending.
  assert.equal(plan.commit.length, 1);
  assert.equal(plan.commit[0]?.proposalContent, proposal);
  assert.deepEqual(plan.remnant, []);
});

test("an accepted create commits whole because it has no partial state", () => {
  // Given: a brand-new file. Its base is empty, so the whole content is one
  // hunk and there is no meaningful half-written state.
  const base = "";
  const proposal = "first\nsecond\n";
  const engine = new JsDiffEngine();
  const hunk = engine.diff(base, proposal).hunks[0];
  assert.ok(hunk);
  const change: ReviewChange = {
    id: "0001",
    operation: "create",
    target: "new.md",
    baseHash: null,
    baseContent: null,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {
      [hunk.id]: {
        decision: "accepted",
        at: new Date().toISOString(),
        baseHash: sha256(base),
        proposalHash: sha256(proposal),
      },
    },
  };

  // When: its only block was accepted.
  const plan = planPartialCommit([change], engine);

  // Then: the file is created whole and nothing is left pending.
  assert.equal(plan.commit.length, 1);
  assert.equal(plan.commit[0]?.proposalContent, proposal);
  assert.deepEqual(plan.remnant, []);
});

test("a rename with only some blocks accepted waits for a whole submission", () => {
  // Given: a rename whose two changed regions are only partly accepted. A rename
  // must move the file in one step, so it cannot be split across batches.
  const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  const base = lines.map((line) => `${line}\n`).join("");
  const proposal = lines
    .map((line, index) => (index === 0 ? "A" : index === 10 ? "K" : line))
    .map((line) => `${line}\n`)
    .join("");
  const engine = new JsDiffEngine();
  const hunks = engine.diff(base, proposal).hunks;
  assert.equal(hunks.length, 2);
  const onlyFirst = hunks[0];
  assert.ok(onlyFirst);
  const change: ReviewChange = {
    id: "0001",
    operation: "rename",
    target: "old.md",
    newTarget: "new.md",
    baseHash: sha256(base),
    baseContent: base,
    proposalContent: proposal,
    proposalHash: sha256(proposal),
    hunkDecisions: {
      [onlyFirst.id]: {
        decision: "accepted",
        at: new Date().toISOString(),
        baseHash: sha256(base),
        proposalHash: sha256(proposal),
      },
    },
  };

  // When: only one of the rename's two blocks is accepted.
  const plan = planPartialCommit([change], engine);

  // Then: it is carried over whole rather than half-applied.
  assert.deepEqual(plan.commit, []);
  assert.equal(plan.remnant.length, 1);
  assert.equal(plan.remnant[0]?.newTarget, "new.md");
  assert.equal(plan.remnant[0]?.proposalContent, proposal);
});

test("vendored Myers adapter reconstructs both sides across deterministic fuzz cases", () => {
  let state = 0x5eed1234;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const sequence = (): string[] => {
    const length = next() % 16;
    return Array.from({ length }, () => "abcdef"[next() % 6] ?? "a");
  };

  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const oldTokens = sequence();
    const newTokens = sequence();
    const components = myersDiff(oldTokens, newTokens, { timeoutMs: 1_000 });
    assert.notEqual(components, undefined);
    if (components === undefined) continue;

    let oldPosition = 0;
    let newPosition = 0;
    for (const component of components) {
      if (component.removed) {
        assert.deepEqual(
          component.values,
          oldTokens.slice(oldPosition, oldPosition + component.values.length),
        );
        oldPosition += component.values.length;
      } else if (component.added) {
        assert.deepEqual(
          component.values,
          newTokens.slice(newPosition, newPosition + component.values.length),
        );
        newPosition += component.values.length;
      } else {
        assert.deepEqual(
          component.values,
          oldTokens.slice(oldPosition, oldPosition + component.values.length),
        );
        assert.deepEqual(
          component.values,
          newTokens.slice(newPosition, newPosition + component.values.length),
        );
        oldPosition += component.values.length;
        newPosition += component.values.length;
      }
    }
    assert.equal(oldPosition, oldTokens.length);
    assert.equal(newPosition, newTokens.length);
  }
});
