"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function zipDirectory(cwd, directory, destination) {
  if (process.platform === "win32") {
    run(windowsTar(), ["-a", "-c", "-f", destination, directory], cwd);
    return;
  }
  run("zip", ["-q", "-r", destination, directory], cwd);
}

function testZip(filename, cwd) {
  if (process.platform === "win32") {
    run(windowsTar(), ["-t", "-f", filename], cwd);
    return;
  }
  run("unzip", ["-t", filename], cwd);
}

function windowsTar() {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined) {
    throw new Error("SystemRoot is required to locate Windows tar.exe.");
  }
  return path.join(systemRoot, "System32", "tar.exe");
}

function run(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

module.exports = { testZip, zipDirectory };
