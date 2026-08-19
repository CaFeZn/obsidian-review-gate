"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const roots = [path.join(root, "packages"), path.join(root, "tests")];
const forbidden = [
  { pattern: /@ts-ignore|@ts-nocheck/gu, message: "TypeScript suppression directive" },
  { pattern: /\bas\s+any\b|:\s*any\b|<any>|\bany\[\]/gu, message: "explicit any" },
  { pattern: /\b(?:test|describe|it)\.(?:skip|only)\s*\(/gu, message: "skipped or focused test" },
  { pattern: /eslint-disable/gu, message: "blanket ESLint suppression" },
];

const failures = [];
for (const file of walk(roots)) {
  const text = fs.readFileSync(file, "utf8");
  for (const rule of forbidden) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${path.relative(root, file)}:${line}: ${rule.message}: ${match[0]}`);
    }
  }
}

for (const file of walk([path.join(root, "packages", "core")])) {
  const text = fs.readFileSync(file, "utf8");
  if (/from\s+["']obsidian["']|require\(["']obsidian["']\)/u.test(text)) {
    failures.push(`${path.relative(root, file)}: core must not depend on Obsidian`);
  }
}

const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
if (tsconfig.compilerOptions?.strict !== true) failures.push("tsconfig.json: strict must be true");
if (tsconfig.compilerOptions?.skipLibCheck !== false) failures.push("tsconfig.json: skipLibCheck must be false");

if (failures.length > 0) {
  console.error("Source policy check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Source policy check passed (strict config, no suppression, no explicit any, no skipped tests, core is Obsidian-free)." );

function* walk(startDirectories) {
  for (const start of startDirectories) {
    if (!fs.existsSync(start)) continue;
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
      }
    }
  }
}
