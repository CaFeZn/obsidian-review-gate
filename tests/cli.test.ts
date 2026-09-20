import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsDiffEngine } from "../packages/core/src/diff/jsdiff-engine";
import { cleanupVault, createVault, readVaultFile, writeVaultFile } from "./helpers";

const projectRoot = path.resolve(__dirname, "..", "..");
const cliEntry = path.join(projectRoot, "dist", "packages", "cli", "src", "main.js");

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly document: Record<string, unknown>;
}

function runCli(args: readonly string[], reviewHome: string): CliRun {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, OBSREVIEW_HOME: reviewHome },
  });
  const stdout = result.stdout.trim();
  return {
    status: result.status,
    stdout,
    stderr: result.stderr,
    document: stdout.length === 0 ? {} : (JSON.parse(stdout) as Record<string, unknown>),
  };
}

test("CLI submit/status/update/cancel use one-line machine JSON and stable exit codes", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "Framework/CAN.md", "base\n");
    const firstProposal = path.join(vault, "proposal-1.md");
    const secondProposal = path.join(vault, "proposal-2.md");
    await writeFile(firstProposal, "proposal one\n", "utf8");
    await writeFile(secondProposal, "proposal two\n", "utf8");

    const submit = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "Framework/CAN.md",
      "--file",
      firstProposal,
      "--agent",
      "codex",
      "--json",
    ], reviewHome);
    assert.equal(submit.status, 0, submit.stderr);
    assert.equal(submit.document["ok"], true);
    assert.equal(submit.document["status"], "pending");
    assert.equal(submit.stdout.split("\n").length, 1);
    assert.equal(await readVaultFile(vault, "Framework/CAN.md"), "base\n");
    await assert.rejects(access(path.join(vault, ".obsreview")));
    await access(path.join(reviewHome, "vaults"));
    const reviewId = submit.document["reviewId"];
    assert.equal(typeof reviewId, "string");

    const status = runCli([
      "status",
      String(reviewId),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(status.status, 0);
    assert.equal(status.document["revision"], 1);

    const update = runCli([
      "update",
      String(reviewId),
      "--vault",
      vault,
      "--change",
      "0001",
      "--file",
      secondProposal,
      "--expected-revision",
      "1",
      "--json",
    ], reviewHome);
    assert.equal(update.status, 0, update.stderr);
    assert.equal(update.document["revision"], 2);
    assert.equal(await readVaultFile(vault, "Framework/CAN.md"), "base\n");

    const cancel = runCli([
      "cancel",
      String(reviewId),
      "--vault",
      vault,
      "--expected-revision",
      "2",
      "--json",
    ], reviewHome);
    assert.equal(cancel.status, 6);
    assert.equal(cancel.document["status"], "cancelled");
    assert.equal(await readVaultFile(vault, "Framework/CAN.md"), "base\n");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI update refuses target drift without mutating the proposal", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const firstProposal = path.join(vault, "first.md");
    const secondProposal = path.join(vault, "second.md");
    await writeFile(firstProposal, "proposal one\n", "utf8");
    await writeFile(secondProposal, "proposal two\n", "utf8");
    const submit = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      firstProposal,
      "--json",
    ], reviewHome);
    assert.equal(submit.status, 0, submit.stderr);
    await writeVaultFile(vault, "note.md", "human edit\n");

    const update = runCli([
      "update",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--change",
      "0001",
      "--file",
      secondProposal,
      "--expected-revision",
      "1",
      "--json",
    ], reviewHome);

    assert.equal(update.status, 4);
    assert.equal(update.document["code"], "REVIEW_CONFLICT");
    const show = runCli([
      "show",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(show.document["revision"], 1);
    const change = (show.document["changes"] as Record<string, unknown>[])[0];
    assert.equal(change?.["proposalContent"], "proposal one\n");
    assert.equal(await readVaultFile(vault, "note.md"), "human edit\n");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI hunk refuses target drift without mutating hunk decisions", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    const base = "one\ntwo\nthree\n";
    const proposal = "one\nTWO\nthree\n";
    await writeVaultFile(vault, "note.md", base);
    const proposalFile = path.join(vault, "proposal.md");
    await writeFile(proposalFile, proposal, "utf8");
    const submit = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      proposalFile,
      "--json",
    ], reviewHome);
    assert.equal(submit.status, 0, submit.stderr);
    const hunk = new JsDiffEngine().diff(base, proposal).hunks[0];
    assert.ok(hunk);
    await writeVaultFile(vault, "note.md", "human edit\n");

    const decision = runCli([
      "hunk",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--change",
      "0001",
      "--hunk-id",
      hunk.id,
      "--decision",
      "reject",
      "--expected-revision",
      "1",
      "--json",
    ], reviewHome);

    assert.equal(decision.status, 4);
    assert.equal(decision.document["code"], "REVIEW_CONFLICT");
    const show = runCli([
      "show",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(show.document["revision"], 1);
    const change = (show.document["changes"] as Record<string, unknown>[])[0];
    assert.equal(change?.["proposalContent"], proposal);
    assert.deepEqual(change?.["hunkDecisions"], {});
    assert.equal(await readVaultFile(vault, "note.md"), "human edit\n");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI rejects traversal with exit 2 and structured error", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    const proposal = path.join(vault, "proposal.md");
    await writeFile(proposal, "x", "utf8");
    const result = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "../outside.md",
      "--file",
      proposal,
      "--json",
    ], reviewHome);
    assert.equal(result.status, 2);
    assert.equal(result.document["ok"], false);
    assert.equal(result.document["code"], "INVALID_TARGET_PATH");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI manifest creates a multi-file review without touching targets", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "A.md", "A0\n");
    await writeFile(path.join(vault, "a-new.md"), "A1\n", "utf8");
    await writeFile(path.join(vault, "b-new.md"), "B1\n", "utf8");
    const manifest = path.join(vault, "review.json");
    await writeFile(
      manifest,
      JSON.stringify({
        agent: "deepseek",
        changes: [
          { target: "A.md", file: "a-new.md" },
          { operation: "create", target: "B.md", file: "b-new.md" },
        ],
      }),
      "utf8",
    );
    const result = runCli([
      "submit",
      "--vault",
      vault,
      "--manifest",
      manifest,
      "--json",
    ], reviewHome);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.document["changes"] as unknown[]).length, 2);
    assert.equal(await readVaultFile(vault, "A.md"), "A0\n");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI wait blocks on watcher and returns cancelled with exit 6", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const proposal = path.join(vault, "proposal.md");
    await writeFile(proposal, "proposal\n", "utf8");
    const submit = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      proposal,
      "--json",
    ], reviewHome);
    const reviewId = String(submit.document["reviewId"]);

    const child = spawn(
      process.execPath,
      [
        cliEntry,
        "wait",
        reviewId,
        "--vault",
        vault,
        "--timeout-ms",
        "3000",
        "--json",
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, OBSREVIEW_HOME: reviewHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const cancel = runCli(["cancel", reviewId, "--vault", vault, "--json"], reviewHome);
    assert.equal(cancel.status, 6);
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });
    assert.equal(exitCode, 6, stderr);
    const document = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.equal(document["status"], "cancelled");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI append merges non-overlapping edits into the existing review", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "one\ntwo\nthree\n");
    const humanProposal = path.join(vault, "human.md");
    const agentProposal = path.join(vault, "agent.md");
    await writeFile(humanProposal, "one\nHUMAN\ntwo\nthree\n", "utf8");
    await writeFile(agentProposal, "ZERO\none\ntwo\nthree\nAGENT\n", "utf8");

    const submit = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      humanProposal,
      "--json",
    ], reviewHome);
    assert.equal(submit.status, 0, submit.stderr);
    await writeVaultFile(vault, "note.md", "ZERO\none\ntwo\nthree\n");

    const append = runCli([
      "append",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      agentProposal,
      "--agent",
      "codex",
      "--json",
    ], reviewHome);
    assert.equal(append.status, 0, append.stderr);
    assert.equal(append.document["reviewId"], submit.document["reviewId"]);
    assert.equal(append.document["revision"], 2);

    const show = runCli([
      "show",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    const change = (show.document["changes"] as Record<string, unknown>[])[0];
    assert.equal(change?.["proposalContent"], "ZERO\none\nHUMAN\ntwo\nthree\nAGENT\n");
    assert.equal(await readVaultFile(vault, "note.md"), "ZERO\none\ntwo\nthree\n");

    const list = runCli([
      "list",
      "--vault",
      vault,
      "--status",
      "pending,conflicted",
      "--json",
    ], reviewHome);
    assert.equal(list.document["count"], 1);

    const approve = runCli([
      "approve",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--expected-revision",
      "2",
      "--json",
    ], reviewHome);
    assert.equal(approve.status, 0, JSON.stringify(approve.document));
    assert.equal(
      await readVaultFile(vault, "note.md"),
      "ZERO\none\nHUMAN\ntwo\nthree\nAGENT\n",
    );
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI append creates a review only when no mutable review matches", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const proposal = path.join(vault, "proposal.md");
    await writeFile(proposal, "proposal\n", "utf8");

    const append = runCli([
      "append",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      proposal,
      "--json",
    ], reviewHome);
    assert.equal(append.status, 0, append.stderr);
    assert.equal(append.document["status"], "pending");
    assert.equal(await readVaultFile(vault, "note.md"), "base\n");

    const list = runCli(["list", "--vault", vault, "--json"], reviewHome);
    assert.equal(list.document["count"], 1);
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI submit refuses a target already owned by a mutable review", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "base\n");
    const firstProposal = path.join(vault, "first.md");
    const secondProposal = path.join(vault, "second.md");
    await writeFile(firstProposal, "first\n", "utf8");
    await writeFile(secondProposal, "second\n", "utf8");

    const first = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      firstProposal,
      "--json",
    ], reviewHome);
    const second = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      secondProposal,
      "--json",
    ], reviewHome);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 4);
    assert.equal(second.document["code"], "REVIEW_CONFLICT");
    assert.match(String(second.document["message"]), /append/u);

    const list = runCli(["list", "--vault", vault, "--json"], reviewHome);
    assert.equal(list.document["count"], 1);
    const show = runCli([
      "show",
      String(first.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    const change = (show.document["changes"] as Record<string, unknown>[])[0];
    assert.equal(change?.["proposalContent"], "first\n");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test(
  "CLI submit treats target casing as the same mutable path on Windows",
  { skip: process.platform !== "win32" },
  async () => {
    const vault = await createVault();
    const reviewHome = await createVault();
    try {
      await writeVaultFile(vault, "note.md", "base\n");
      const firstProposal = path.join(vault, "first.md");
      const secondProposal = path.join(vault, "second.md");
      await writeFile(firstProposal, "first\n", "utf8");
      await writeFile(secondProposal, "second\n", "utf8");
      const first = runCli([
        "submit",
        "--vault",
        vault,
        "--target",
        "note.md",
        "--file",
        firstProposal,
        "--json",
      ], reviewHome);
      assert.equal(first.status, 0, first.stderr);

      const second = runCli([
        "submit",
        "--vault",
        vault,
        "--target",
        "NOTE.md",
        "--file",
        secondProposal,
        "--json",
      ], reviewHome);

      assert.equal(second.status, 4);
      assert.equal(second.document["code"], "REVIEW_CONFLICT");
      const list = runCli(["list", "--vault", vault, "--json"], reviewHome);
      assert.equal(list.document["count"], 1);
    } finally {
      await cleanupVault(reviewHome);
      await cleanupVault(vault);
    }
  },
);

test("CLI append reports overlapping edits without mutating the existing review", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "note.md", "one\ntwo\nthree\n");
    const humanProposal = path.join(vault, "human.md");
    const agentProposal = path.join(vault, "agent.md");
    await writeFile(humanProposal, "one\nHUMAN\nthree\n", "utf8");
    await writeFile(agentProposal, "one\nAGENT\nthree\n", "utf8");

    const submit = runCli([
      "submit",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      humanProposal,
      "--json",
    ], reviewHome);
    assert.equal(submit.status, 0, submit.stderr);

    const append = runCli([
      "append",
      "--vault",
      vault,
      "--target",
      "note.md",
      "--file",
      agentProposal,
      "--json",
    ], reviewHome);
    assert.equal(append.status, 4);
    assert.equal(append.document["code"], "REBASE_CONFLICT");

    const show = runCli([
      "show",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    const change = (show.document["changes"] as Record<string, unknown>[])[0];
    assert.equal(change?.["proposalContent"], "one\nHUMAN\nthree\n");
    assert.equal(show.document["revision"], 1);
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI append refuses unrelated target drift without creating conflicted state", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "A.md", "one\ntwo\nthree\n");
    await writeVaultFile(vault, "B.md", "B0\n");
    await writeFile(path.join(vault, "a-human.md"), "one\nHUMAN\ntwo\nthree\n", "utf8");
    await writeFile(path.join(vault, "a-agent.md"), "ZERO\none\ntwo\nthree\n", "utf8");
    await writeFile(path.join(vault, "b-proposal.md"), "B1\n", "utf8");
    const manifest = path.join(vault, "review.json");
    await writeFile(
      manifest,
      JSON.stringify({
        changes: [
          { target: "A.md", file: "a-human.md" },
          { target: "B.md", file: "b-proposal.md" },
        ],
      }),
      "utf8",
    );
    const submit = runCli([
      "submit",
      "--vault",
      vault,
      "--manifest",
      manifest,
      "--json",
    ], reviewHome);
    assert.equal(submit.status, 0, submit.stderr);
    await writeVaultFile(vault, "B.md", "human edit\n");

    const append = runCli([
      "append",
      "--vault",
      vault,
      "--target",
      "A.md",
      "--file",
      path.join(vault, "a-agent.md"),
      "--json",
    ], reviewHome);

    assert.equal(append.status, 4);
    assert.equal(append.document["code"], "REVIEW_CONFLICT");
    const show = runCli([
      "show",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(show.document["status"], "pending");
    assert.equal(show.document["revision"], 1);
    const changes = show.document["changes"] as Record<string, unknown>[];
    assert.equal(changes[0]?.["proposalContent"], "one\nHUMAN\ntwo\nthree\n");
    assert.equal(await readVaultFile(vault, "B.md"), "human edit\n");
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI semantic append batches approve independently and revert safely", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    await writeVaultFile(vault, "tasks/A.md", "status: open\n");
    await writeVaultFile(vault, "tasks/B.md", "status: open\n");
    await writeVaultFile(vault, "工作日志/日报/20260920.md", "# 日报\n\n## 当日进度\n\n- existing\n");

    const manifestA = path.join(vault, "batch-a.json");
    const manifestB = path.join(vault, "batch-b.json");
    await writeFile(
      manifestA,
      JSON.stringify({
        batchId: "batch-a",
        changes: [
          { target: "tasks/A.md", content: "status: done\n" },
          {
            operation: "append",
            target: "工作日志/日报/20260920.md",
            anchor: "## 当日进度",
            content: "- [[A]]：完成 A\n",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      manifestB,
      JSON.stringify({
        batchId: "batch-b",
        changes: [
          { target: "tasks/B.md", content: "status: done\n" },
          {
            operation: "append",
            target: "工作日志/日报/20260920.md",
            anchor: "## 当日进度",
            content: "- [[B]]：完成 B\n",
          },
        ],
      }),
      "utf8",
    );

    const batchA = runCli(["submit", "--vault", vault, "--manifest", manifestA, "--json"], reviewHome);
    const batchB = runCli(["submit", "--vault", vault, "--manifest", manifestB, "--json"], reviewHome);
    assert.equal(batchA.status, 0, batchA.stderr);
    assert.equal(batchB.status, 0, batchB.stderr);
    assert.equal(batchA.document["batchId"], "batch-a");
    assert.equal(batchB.document["batchId"], "batch-b");

    const approveA = runCli([
      "approve",
      String(batchA.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(approveA.status, 0, approveA.stderr);
    assert.equal(await readVaultFile(vault, "tasks/A.md"), "status: done\n");
    assert.equal(await readVaultFile(vault, "tasks/B.md"), "status: open\n");
    assert.equal(
      await readVaultFile(vault, "工作日志/日报/20260920.md"),
      "# 日报\n\n## 当日进度\n\n- existing\n- [[A]]：完成 A\n",
    );

    // The compensating review must remain semantic too, so it can coexist with
    // a later batch that is still waiting for approval on the same daily note.
    const revertA = runCli([
      "revert",
      String(batchA.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(revertA.status, 0, revertA.stderr);
    assert.equal(revertA.document["revertsReviewId"], batchA.document["reviewId"]);
    assert.equal(revertA.document["batchId"], "batch-a");
    const approveB = runCli([
      "approve",
      String(batchB.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(approveB.status, 0, approveB.stderr);
    const approveRevert = runCli([
      "approve",
      String(revertA.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(approveRevert.status, 0, approveRevert.stderr);
    assert.equal(await readVaultFile(vault, "tasks/A.md"), "status: open\n");
    assert.equal(await readVaultFile(vault, "tasks/B.md"), "status: done\n");
    assert.equal(
      await readVaultFile(vault, "工作日志/日报/20260920.md"),
      "# 日报\n\n## 当日进度\n\n- existing\n- [[B]]：完成 B\n",
    );
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});

test("CLI revert refuses a semantic fragment changed after approval", async () => {
  const vault = await createVault();
  const reviewHome = await createVault();
  try {
    const target = "工作日志/日报/20260920.md";
    await writeVaultFile(vault, target, "# 日报\n\n## 当日进度\n\n- existing\n");
    const fragment = path.join(vault, "fragment.md");
    await writeFile(fragment, "- [[A]]：完成 A\n", "utf8");

    const submit = runCli([
      "append",
      "--vault",
      vault,
      "--target",
      target,
      "--file",
      fragment,
      "--anchor",
      "## 当日进度",
      "--json",
    ], reviewHome);
    assert.equal(submit.status, 0, submit.stderr);
    const approve = runCli([
      "approve",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);
    assert.equal(approve.status, 0, approve.stderr);

    const edited = "# 日报\n\n## 当日进度\n\n- existing\n- [[A]]：完成 A（人工补充）\n";
    await writeVaultFile(vault, target, edited);
    const revert = runCli([
      "revert",
      String(submit.document["reviewId"]),
      "--vault",
      vault,
      "--json",
    ], reviewHome);

    assert.equal(revert.status, 4);
    assert.equal(revert.document["code"], "REBASE_CONFLICT");
    assert.equal(await readVaultFile(vault, target), edited);
  } finally {
    await cleanupVault(reviewHome);
    await cleanupVault(vault);
  }
});
