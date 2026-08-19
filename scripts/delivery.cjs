"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { testZip, zipDirectory } = require("./archive.cjs");

const root = path.resolve(__dirname, "..");
const parent = path.dirname(root);
const packageDocument = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = packageDocument.version;
const components = [
  path.join(parent, `obsidian-review-gate-plugin-${version}.zip`),
  path.join(parent, `obsreview-cli-${version}.zip`),
  path.join(parent, `obsidian-review-gate-source-${version}.zip`),
];
for (const filename of components) {
  if (!fs.existsSync(filename)) throw new Error(`Missing component: ${filename}`);
}

const checksums = path.join(
  parent,
  `obsidian-review-gate-${version}-SHA256SUMS.txt`,
);
const checksumText = components
  .map((filename) => `${sha256(filename)}  ${path.basename(filename)}`)
  .join("\n");
fs.writeFileSync(checksums, `${checksumText}\n`);

const output = path.join(
  parent,
  `obsidian-review-gate-${version}-delivery.zip`,
);
fs.rmSync(output, { force: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "obsreview-delivery-"));
try {
  const directoryName = `obsidian-review-gate-${version}-delivery`;
  const directory = path.join(temporary, directoryName);
  fs.mkdirSync(directory, { recursive: true });
  for (const filename of components) {
    fs.copyFileSync(filename, path.join(directory, path.basename(filename)));
  }
  fs.copyFileSync(checksums, path.join(directory, path.basename(checksums)));
  fs.copyFileSync(
    path.join(root, "docs", "test-results.md"),
    path.join(directory, "TEST-RESULTS.md"),
  );
  fs.writeFileSync(
    path.join(directory, "DELIVERY-README.txt"),
    [
      `Obsidian Review Gate ${version}`,
      "",
      "Contents:",
      `- obsidian-review-gate-plugin-${version}.zip: copy the extracted obsidian-review-gate directory to <Vault>/.obsidian/plugins/`,
      `- obsreview-cli-${version}.zip: portable Node.js 20+ CLI; use obsreview.cmd on Windows or obsreview on macOS/Linux`,
      `- obsidian-review-gate-source-${version}.zip: full TypeScript source, tests, architecture and protocol documentation`,
      `- obsidian-review-gate-${version}-SHA256SUMS.txt: SHA-256 checksums for the three component archives`,
      "- TEST-RESULTS.md: final validation report",
      "",
      "Core rule: pending reviews and hunk operations never mutate the formal target. Only an approved review may apply after authoritative base-state validation.",
      "",
    ].join("\n"),
  );

  zipDirectory(temporary, directoryName, output);
  testZip(output, root);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`checksums: ${checksums}`);
console.log(`delivery: ${output} (${fs.statSync(output).size} bytes)`);

function sha256(filename) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filename));
  return hash.digest("hex");
}
