// Checks the view (plugin/hooks/view.tsx) with Claude Code itself: writes
// the plugin to a temporary folder as `encela setup` would, then runs
// `claude plugin validate` and `claude plugin test` on it. Needs the
// `claude` command, so it is not part of `pnpm test`.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, args, env = {}) =>
  spawnSync(command, args, {
    cwd: here,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });

if (spawnSync("claude", ["--version"], { shell: process.platform === "win32" }).status !== 0) {
  console.log("Claude Code (the claude command) isn't here: the view was not checked.");
  process.exit(0);
}
const home = mkdtempSync(join(tmpdir(), "encela-view-"));
let failed = 0;
try {
  failed ||= run(process.execPath, ["build.mjs"]).status ?? 1;
  failed ||=
    run(process.execPath, ["dist/cli.js", "setup", "--no-claude"], { ENCELA_HOME: home }).status ??
    1;
  const plugin = join(home, "claude-plugin", "plugins", "encela");
  // The tests stay out of the package: they go in only for this run.
  cpSync(join(here, "plugin", "tests"), join(plugin, "tests"), { recursive: true });
  failed ||= run("claude", ["plugin", "validate", plugin]).status ?? 1;
  failed ||= run("claude", ["plugin", "test", plugin]).status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
