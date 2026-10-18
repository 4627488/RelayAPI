#!/usr/bin/env node
// Build the pinned runtime used by the Relay image. No daemon is started.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const cursorRuntimeRevision = "898ffd41b78b2c1a85b5b1c9475517af6fa5834b";
const destination = path.resolve(process.argv[2] || ".cache/cursor-runtime");
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Cursor runtime requires Node.js >=24");
if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
function run(command, args, cwd) {
  if (command === "npm" && process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    args = [process.env.npm_execpath, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && command === "npm" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
run("git", ["init", destination]);
run("git", ["remote", "add", "origin", "https://github.com/iFwu/cursor2response.git"], destination);
run("git", ["fetch", "--depth=1", "origin", cursorRuntimeRevision], destination);
run("git", ["checkout", "--detach", cursorRuntimeRevision], destination);
run("npm", ["ci", "--no-audit", "--no-fund"], destination);
run("npm", ["run", "build:server"], destination);
run("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], destination);
console.log(`Cursor runtime built at ${destination}; set RELAY_CURSOR_RUNTIME_DIR to this directory.`);
