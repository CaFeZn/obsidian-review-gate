import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
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
    await access(path.join(vault, ".obsreview"));
    await assert.rejects(access(path.join(reviewHome, "vaults")));
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
