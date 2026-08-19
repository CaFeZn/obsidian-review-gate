"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipDirectory } = require("./archive.cjs");

const root = path.resolve(__dirname, "..");
const parent = path.dirname(root);
const packageDocument = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageDocument.version;
const outputs = {
  plugin: path.join(parent, `obsidian-review-gate-plugin-${version}.zip`),
  cli: path.join(parent, `obsreview-cli-${version}.zip`),
  source: path.join(parent, `obsidian-review-gate-source-${version}.zip`),
};
for (const output of Object.values(outputs)) fs.rmSync(output, { force: true });

zipDirectory(path.join(root, "release"), "obsidian-review-gate", outputs.plugin);
zipDirectory(path.join(root, "release"), "obsreview-cli", outputs.cli);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "obsreview-package-"));
try {
  const sourceName = `obsidian-review-gate-source-${version}`;
  const sourceRoot = path.join(temporary, sourceName);
  fs.mkdirSync(sourceRoot, { recursive: true });
  for (const entry of [
    ".gitignore",
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "CHANGELOG.md",
    "manifest.json",
    "package.json",
    "tsconfig.json",
    "versions.json",
    "docs",
    "examples",
    "packages",
    "scripts",
    "tests",
  ]) {
    const source = path.join(root, entry);
    if (!fs.existsSync(source)) continue;
    copyTree(source, path.join(sourceRoot, entry));
  }
  zipDirectory(temporary, sourceName, outputs.source);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

for (const [kind, filename] of Object.entries(outputs)) {
  const bytes = fs.statSync(filename).size;
  console.log(`${kind}: ${filename} (${bytes} bytes)`);
}

function copyTree(source, destination) {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (entry === "node_modules" || entry === "dist" || entry === "release") continue;
      copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
