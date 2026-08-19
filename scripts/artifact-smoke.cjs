"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const parent = path.dirname(root);
const packageDocument = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = packageDocument.version;
const archives = {
  plugin: path.join(parent, `obsidian-review-gate-plugin-${version}.zip`),
  cli: path.join(parent, `obsreview-cli-${version}.zip`),
  source: path.join(parent, `obsidian-review-gate-source-${version}.zip`),
};

for (const filename of Object.values(archives)) {
  if (!fs.existsSync(filename)) {
    throw new Error(`Expected package is missing: ${filename}`);
  }
  run("unzip", ["-t", filename]);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "obsreview-artifact-smoke-"));
try {
  run("unzip", ["-q", archives.plugin, "-d", path.join(temporary, "plugin")]);
  run("unzip", ["-q", archives.cli, "-d", path.join(temporary, "cli")]);

  smokePlugin(
    path.join(
      temporary,
      "plugin",
      "obsidian-review-gate",
      "main.js",
    ),
  );
  smokeCli(
    path.join(temporary, "cli", "obsreview-cli", "obsreview.js"),
    temporary,
  );
  console.log("Packaged artifact smoke passed: archives, plugin eval, CLI workflow.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function smokePlugin(entry) {
  const source = fs.readFileSync(entry, "utf8");
  if (/\brequire\((["'])\.{1,2}[\\/]/u.test(source)) {
    throw new Error("Extracted plugin contains a relative require call.");
  }

  class StubPlugin {}
  class StubItemView {}
  class StubModal {}
  class StubNotice {}
  class StubWorkspaceLeaf {}

  const pluginModule = { exports: {} };
  const externalRequire = (request) => {
    if (request === "obsidian") {
      return {
        Plugin: StubPlugin,
        ItemView: StubItemView,
        Modal: StubModal,
        Notice: StubNotice,
        WorkspaceLeaf: StubWorkspaceLeaf,
      };
    }
    if (request.startsWith(".")) {
      throw new Error(`Extracted plugin attempted relative require: ${request}`);
    }
    return require(request);
  };

  const evaluate = new Function(
    "require",
    "module",
    "exports",
    "__filename",
    "__dirname",
    source,
  );
  evaluate(
    externalRequire,
    pluginModule,
    pluginModule.exports,
    entry,
    path.dirname(entry),
  );
  if (typeof pluginModule.exports !== "function") {
    throw new Error("Extracted plugin did not export its constructor.");
  }
}

function smokeCli(cli, temporary) {
  const versionResult = invokeCli(cli, ["--version", "--json"]);
  const versionDocument = parseJson(versionResult.stdout, "CLI version");
  if (versionDocument.ok !== true || versionDocument.version !== version) {
    throw new Error(`Unexpected extracted CLI version: ${versionResult.stdout}`);
  }

  const vault = path.join(temporary, "vault");
  const target = path.join(vault, "Framework", "CAN.md");
  const proposal = path.join(temporary, "proposal.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "# CAN\n\nBase\n");
  fs.writeFileSync(proposal, "# CAN\n\nPackaged proposal\n");

  const submitResult = invokeCli(cli, [
    "submit",
    "--vault",
    vault,
    "--target",
    "Framework/CAN.md",
    "--file",
    proposal,
    "--agent",
    "artifact-smoke",
    "--json",
  ]);
  const submit = parseJson(submitResult.stdout, "CLI submit");
  if (submit.ok !== true || submit.status !== "pending") {
    throw new Error(`Extracted CLI submit failed: ${submitResult.stdout}`);
  }
  if (fs.readFileSync(target, "utf8") !== "# CAN\n\nBase\n") {
    throw new Error("Packaged pending submit mutated the target.");
  }
  if (!fs.existsSync(path.join(vault, ".obsreview"))) {
    throw new Error("Packaged pending submit did not create shared review storage inside the vault.");
  }

  const approveResult = invokeCli(cli, [
    "approve",
    submit.reviewId,
    "--vault",
    vault,
    "--actor",
    "artifact-smoke-human",
    "--json",
  ]);
  const approve = parseJson(approveResult.stdout, "CLI approve");
  if (approve.ok !== true || approve.status !== "approved") {
    throw new Error(`Extracted CLI approve failed: ${approveResult.stdout}`);
  }
  if (fs.readFileSync(target, "utf8") !== "# CAN\n\nPackaged proposal\n") {
    throw new Error("Packaged CLI approve did not apply the proposal.");
  }
}

function invokeCli(cli, arguments_) {
  const result = spawnSync(process.execPath, [cli, ...arguments_], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `CLI exited ${result.status}`);
  }
  return result;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${text}`, { cause: error });
  }
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}
