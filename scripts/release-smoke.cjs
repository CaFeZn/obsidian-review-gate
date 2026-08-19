"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "release", "obsreview-cli", "obsreview.js");
if (!fs.existsSync(cli)) throw new Error("Standalone CLI release is missing. Run npm run build first.");

const version = invoke(["--version", "--json"]);
if (version.status !== 0) throw new Error(version.stderr || version.stdout);
const versionDocument = JSON.parse(version.stdout);
if (versionDocument.ok !== true || versionDocument.version !== "0.1.0") {
  throw new Error(`Unexpected standalone CLI version output: ${version.stdout}`);
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "obsreview-release-smoke-"));
try {
  fs.mkdirSync(path.join(vault, "Framework"), { recursive: true });
  const target = path.join(vault, "Framework", "CAN.md");
  const proposal = path.join(vault, "proposal.md");
  fs.writeFileSync(target, "# CAN\n\nBase\n");
  fs.writeFileSync(proposal, "# CAN\n\nRelease proposal\n");

  const submit = invoke([
    "submit",
    "--vault",
    vault,
    "--target",
    "Framework/CAN.md",
    "--file",
    proposal,
    "--agent",
    "release-smoke",
    "--json",
  ]);
  if (submit.status !== 0) throw new Error(submit.stderr || submit.stdout);
  const document = JSON.parse(submit.stdout);
  if (document.ok !== true || document.status !== "pending") {
    throw new Error(`Standalone submit failed: ${submit.stdout}`);
  }
  if (fs.readFileSync(target, "utf8") !== "# CAN\n\nBase\n") {
    throw new Error("Standalone pending submit mutated target.");
  }

  const approve = invoke([
    "approve",
    document.reviewId,
    "--vault",
    vault,
    "--json",
  ]);
  if (approve.status !== 0) throw new Error(approve.stderr || approve.stdout);
  if (fs.readFileSync(target, "utf8") !== "# CAN\n\nRelease proposal\n") {
    throw new Error("Standalone approve did not apply proposal.");
  }
  console.log(`Standalone release CLI smoke passed: ${document.reviewId}`);
} finally {
  fs.rmSync(vault, { recursive: true, force: true });
}

function invoke(arguments_) {
  return spawnSync(process.execPath, [cli, ...arguments_], { encoding: "utf8" });
}
