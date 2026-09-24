#!/usr/bin/env node
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3 || process.argv[2] !== "authorize") {
  process.stderr.write("Usage: kestrel authorize\n");
  process.exitCode = 1;
} else {
  // Keep the selected folder separate from the installation's tools and state.
  process.env.INIT_CWD = process.cwd();
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  await import("./local-development.mjs");
}
