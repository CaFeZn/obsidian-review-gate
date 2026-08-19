"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "release", "obsidian-review-gate", "main.js");
if (!fs.existsSync(entry)) {
  throw new Error("Plugin release is missing. Run npm run build first.");
}

class StubPlugin {}
class StubItemView {}
class StubModal {}
class StubNotice {}
class StubWorkspaceLeaf {}

const source = fs.readFileSync(entry, "utf8");

// A standard Obsidian plugin release is one evaluated main.js. Relative
// require calls would make the release depend on undeclared companion files.
if (/\brequire\((["'])\.{1,2}[\\/]/u.test(source)) {
  throw new Error("Plugin release still contains a relative require call.");
}
for (const request of ["@codemirror/state", "@codemirror/view"]) {
  const doubleQuoted = `require("${request}")`;
  const singleQuoted = `require('${request}')`;
  if (!source.includes(doubleQuoted) && !source.includes(singleQuoted)) {
    throw new Error(`Plugin release lost its Obsidian-provided ${request} external.`);
  }
}
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
    throw new Error(`Release main.js attempted an unbundled relative require: ${request}`);
  }
  return require(request);
};

// Obsidian loads/evaluates one main.js. This intentionally avoids Node's normal
// relative module resolution, so an accidental multi-file release fails here.
const evaluate = new Function(
  "require",
  "module",
  "exports",
  "__filename",
  "__dirname",
  source,
);
evaluate(externalRequire, pluginModule, pluginModule.exports, entry, path.dirname(entry));
if (typeof pluginModule.exports !== "function") {
  throw new Error(
    `Plugin entry did not export a constructor: ${typeof pluginModule.exports}`,
  );
}
console.log("Plugin single-file eval/load smoke passed.");
