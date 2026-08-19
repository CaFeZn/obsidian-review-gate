#!/usr/bin/env node
"use strict";
const path = require("node:path");
const entry = path.resolve(__dirname, "../../../dist/packages/cli/src/main.js");
try {
  const { run } = require(entry);
  Promise.resolve(run(process.argv.slice(2))).then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
} catch (error) {
  process.stderr.write(
    `obsreview is not built. Run \"npm run build\" first.\n${error && error.message ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
