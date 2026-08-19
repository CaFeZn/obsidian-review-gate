"use strict";
const fs = require("node:fs");
const path = require("node:path");
for (const name of ["dist", "release"]) {
  fs.rmSync(path.resolve(__dirname, "..", name), { recursive: true, force: true });
}
