"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "obsreview-smoke-"));
fs.mkdirSync(path.join(vault, "Framework"), { recursive: true });
fs.writeFileSync(path.join(vault, "Framework", "CAN.md"), "# CAN\n\nBase\n");
const proposal = path.join(vault, "proposal.md");
fs.writeFileSync(proposal, "# CAN\n\nProposed\n");
const cli = path.join(root, "dist", "packages", "cli", "src", "main.js");
const submit = spawnSync(process.execPath, [cli, "submit", "--vault", vault, "--target", "Framework/CAN.md", "--file", proposal, "--agent", "smoke", "--json"], { encoding: "utf8" });
if (submit.status !== 0) throw new Error(submit.stderr || submit.stdout);
const document = JSON.parse(submit.stdout);
if (!document.ok || document.status !== "pending") throw new Error("submit smoke failed");
if (fs.readFileSync(path.join(vault, "Framework", "CAN.md"), "utf8") !== "# CAN\n\nBase\n") {
  throw new Error("pending submit mutated target");
}
const approve = spawnSync(process.execPath, [cli, "approve", document.reviewId, "--vault", vault, "--json"], { encoding: "utf8" });
if (approve.status !== 0) throw new Error(approve.stderr || approve.stdout);
if (fs.readFileSync(path.join(vault, "Framework", "CAN.md"), "utf8") !== "# CAN\n\nProposed\n") {
  throw new Error("approve smoke did not apply proposal");
}
console.log(`Smoke workflow passed: ${document.reviewId}`);
fs.rmSync(vault, { recursive: true, force: true });
