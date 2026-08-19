"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distRoot = path.join(root, "dist");
const packageDocument = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = packageDocument.version;

fs.rmSync(distRoot, { recursive: true, force: true });
fs.rmSync(path.join(root, "release"), { recursive: true, force: true });

const tsc = spawnSync("tsc", ["-p", "tsconfig.json"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

buildPluginRelease();
buildCliRelease();
fs.chmodSync(path.join(root, "packages", "cli", "bin", "obsreview.cjs"), 0o755);
console.log(`Build complete: plugin=single-file, cli=single-file, version=${version}.`);

function buildPluginRelease() {
  const release = path.join(root, "release", "obsidian-review-gate");
  fs.mkdirSync(release, { recursive: true });
  copyRequired(
    path.join(root, "packages", "obsidian-plugin", "manifest.json"),
    path.join(release, "manifest.json"),
  );
  copyRequired(
    path.join(root, "packages", "obsidian-plugin", "styles.css"),
    path.join(release, "styles.css"),
  );

  let mode;
  try {
    const esbuild = require("esbuild");
    esbuild.buildSync({
      entryPoints: [path.join(root, "packages", "obsidian-plugin", "src", "main.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      external: ["obsidian", "@codemirror/state", "@codemirror/view"],
      outfile: path.join(release, "main.js"),
      footer: { js: "module.exports = module.exports.default || module.exports;" },
      sourcemap: true,
      logLevel: "info",
    });
    mode = "single-file-esbuild-plugin";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `esbuild unavailable; using the validated single-file internal CJS bundler: ${detail}`,
    );
    const entry = path.join(distRoot, "packages", "obsidian-plugin", "src", "main.js");
    const bundled = bundleCommonJs(entry, {
      shebang: null,
      bootstrap: (entryId) =>
        `const __entry = __require(${JSON.stringify(entryId)});\n` +
        "module.exports = __entry.default || __entry;\n",
    });
    fs.writeFileSync(path.join(release, "main.js"), bundled);
    mode = "single-file-internal-commonjs-bundle";
  }

  copyReleaseDocumentation(release);
  fs.writeFileSync(
    path.join(release, "BUILD-INFO.json"),
    `${JSON.stringify(
      {
        name: "Obsidian Review Gate",
        version,
        mode,
        codeMirror: "external-provided-by-obsidian-runtime",
        node: process.version,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return mode;
}

function buildCliRelease() {
  const release = path.join(root, "release", "obsreview-cli");
  fs.mkdirSync(release, { recursive: true });
  const entry = path.join(distRoot, "packages", "cli", "src", "main.js");
  const bundled = bundleCommonJs(entry, {
    shebang: "#!/usr/bin/env node",
    bootstrap: (entryId) =>
      `const __entry = __require(${JSON.stringify(entryId)});\n` +
      "module.exports = __entry;\n" +
      "if (require.main === module) {\n" +
      "  Promise.resolve(__entry.run(process.argv.slice(2))).then(\n" +
      "    (code) => { process.exitCode = code; },\n" +
      "    (error) => {\n" +
      "      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\\n`);\n" +
      "      process.exitCode = 1;\n" +
      "    },\n" +
      "  );\n" +
      "}\n",
  });
  const cliEntry = path.join(release, "obsreview.js");
  fs.writeFileSync(cliEntry, bundled);
  fs.chmodSync(cliEntry, 0o755);
  fs.writeFileSync(
    path.join(release, "obsreview"),
    '#!/usr/bin/env sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec node "$SCRIPT_DIR/obsreview.js" "$@"\n',
  );
  fs.writeFileSync(
    path.join(release, "obsreview.cmd"),
    '@echo off\r\nnode "%~dp0obsreview.js" %*\r\nexit /b %ERRORLEVEL%\r\n',
  );
  fs.chmodSync(path.join(release, "obsreview"), 0o755);

  fs.writeFileSync(
    path.join(release, "package.json"),
    `${JSON.stringify(
      {
        name: "obsreview-portable",
        version,
        private: true,
        description: "Portable CLI for Obsidian Review Gate",
        license: "MIT",
        bin: { obsreview: "obsreview.js" },
        engines: { node: ">=20.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  copyReleaseDocumentation(release);
  copyRequired(
    path.join(root, "docs", "protocol.md"),
    path.join(release, "PROTOCOL.md"),
  );
  writeBuildInfo(release, {
    name: "obsreview",
    version,
    mode: "single-file-internal-commonjs-bundle",
    requiredNode: ">=20.0.0",
    node: process.version,
    builtAt: new Date().toISOString(),
  });
}

/**
 * Bundle the project's emitted CommonJS graph without third-party build tools.
 * Relative requires are resolved and embedded. Node built-ins, Obsidian, and
 * optional CodeMirror modules remain normal runtime requires.
 */
function bundleCommonJs(entryFile, options) {
  const modules = new Map();
  const entryId = visit(path.resolve(entryFile));
  const moduleDefinitions = [...modules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, code]) =>
        `${JSON.stringify(id)}: function(module, exports, __require) {\n${indent(code, 2)}\n}`,
    )
    .join(",\n");

  const shebang = options.shebang === null ? "" : `${options.shebang}\n`;
  return (
    `${shebang}"use strict";\n` +
    "const __modules = {\n" +
    `${indent(moduleDefinitions, 2)}\n` +
    "};\n" +
    "const __cache = Object.create(null);\n" +
    "function __require(id) {\n" +
    "  const cached = __cache[id];\n" +
    "  if (cached !== undefined) return cached.exports;\n" +
    "  const factory = __modules[id];\n" +
    "  if (factory === undefined) throw new Error(`Bundled module not found: ${id}`);\n" +
    "  const bundledModule = { exports: {} };\n" +
    "  __cache[id] = bundledModule;\n" +
    "  factory(bundledModule, bundledModule.exports, __require);\n" +
    "  return bundledModule.exports;\n" +
    "}\n" +
    options.bootstrap(entryId)
  );

  function visit(filename) {
    const normalized = path.resolve(filename);
    const id = moduleId(normalized);
    if (modules.has(id)) return id;
    // Reserve the ID before visiting dependencies so circular graphs terminate.
    modules.set(id, "");
    let code = fs.readFileSync(normalized, "utf8");
    code = code.replace(/^#!.*\r?\n/u, "");
    code = code.replace(/\r?\n?\/\/# sourceMappingURL=.*$/u, "");
    code = code.replace(
      /\brequire\((['"])([^'"\r\n]+)\1\)/gu,
      (match, _quote, request) => {
        if (!request.startsWith(".")) return match;
        const dependency = resolveRelativeModule(normalized, request);
        const dependencyId = visit(dependency);
        return `__require(${JSON.stringify(dependencyId)})`;
      },
    );
    modules.set(id, code);
    return id;
  }
}

function resolveRelativeModule(importer, request) {
  const base = path.resolve(path.dirname(importer), request);
  const candidates = [base, `${base}.js`, path.join(base, "index.js")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve ${request} from ${importer}`);
}

function moduleId(filename) {
  const relative = path.relative(distRoot, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Bundled source escaped dist/: ${filename}`);
  }
  return relative.split(path.sep).join("/");
}

function indent(text, spaces) {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function copyReleaseDocumentation(destination) {
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) {
    copyRequired(path.join(root, name), path.join(destination, name));
  }
  const licenses = path.join(destination, "LICENSES");
  fs.mkdirSync(licenses, { recursive: true });
  copyRequired(
    path.join(root, "packages", "core", "src", "vendor", "jsdiff", "LICENSE"),
    path.join(licenses, "jsdiff-BSD-3-Clause.txt"),
  );
}

function copyRequired(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function writeBuildInfo(release, document) {
  fs.writeFileSync(
    path.join(release, "BUILD-INFO.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}
