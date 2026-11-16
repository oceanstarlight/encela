import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findOnWindows, launch } from "./.build/lib.js";

const NODE = "C:\\Program Files\\nodejs";
const files = new Set(
  [
    `${NODE}\\node.exe`,
    `${NODE}\\npx`,
    `${NODE}\\npx.cmd`,
    "C:\\tools\\uvx.exe",
    "C:\\proj\\npx.cmd",
    "C:\\proj\\tools\\run.bat",
  ].map((f) => f.toLowerCase()),
);
const win = {
  platform: "win32",
  env: {
    Path: `${NODE};"C:\\tools";.;relative`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\W\\cmd.exe",
  },
  exists: (f) => files.has(f.toLowerCase()),
};

test("elsewhere than Windows a command goes as it is", () => {
  assert.deepEqual(launch("npx", ["a b", "&"], { platform: "linux" }), {
    command: "npx",
    args: ["a b", "&"],
    verbatim: false,
  });
});

test("on Windows a name is found on PATH alone, with the extensions Windows tries", () => {
  assert.equal(findOnWindows("npx", win), `${NODE}\\npx.CMD`);
  assert.equal(findOnWindows("npx.cmd", win), `${NODE}\\npx.cmd`);
  assert.equal(findOnWindows("uvx", win), "C:\\tools\\uvx.EXE");
  assert.equal(findOnWindows("nothing", win), null);
  // Not the folder it runs in, and not a relative PATH entry: the project isn't trusted.
  assert.equal(findOnWindows("run", win), null);
  assert.equal(findOnWindows("C:\\proj\\tools\\run", win), "C:\\proj\\tools\\run.BAT");
  assert.throws(() => launch("nothing", [], win), /isn't on PATH/);
  assert.throws(() => launch(".\\nothing.exe", [], win), /isn't there/);
});

test("on Windows a program is started directly and a script through cmd.exe as one line", () => {
  assert.deepEqual(launch("uvx", ["a b", "x&y"], win), {
    command: "C:\\tools\\uvx.EXE",
    args: ["a b", "x&y"],
    verbatim: false,
  });
  const run = launch("npx", ["-y", "pkg@1.2.3", "--dir=C:\\a", "my dir", "a&b"], win);
  assert.equal(run.command, "C:\\W\\cmd.exe");
  assert.equal(run.verbatim, true);
  assert.deepEqual(run.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(
    run.args[3],
    '"C:\\Program^ Files\\nodejs\\npx.CMD -y pkg@1.2.3 --dir=C:\\a ^^^"my^^^ dir^^^" ^^^"a^^^&b^^^""',
  );
  assert.throws(() => launch("npx", ["a\nb"], win), /line break/);
});

// The real thing, where there is a cmd.exe: what a program started from a
// .cmd file reads is what was passed.
test("arguments reach a program behind a .cmd file whole", {
  skip: process.platform !== "win32",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "encela spawn & co "));
  writeFileSync(join(dir, "show.js"), "console.log(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(dir, "show.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0show.js" %*\r\n`);
  const args = [
    "plain",
    "",
    "two words",
    "a&b",
    "a|b>c<d",
    "100%",
    "%PATH%",
    "^caret^",
    'say "hi"',
    'q" & echo x',
    "back\\",
    "back slash\\",
    'tail\\"',
    "(paren)",
    "a;b,c",
    "bang!",
    "C:\\Users\\A B\\바탕 화면\\x",
    '{"a":"b c","d":[1,2]}',
    "--opt=va lue",
    "*?",
  ];
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  const run = launch("show", args, { env });
  const r = spawnSync(run.command, run.args, {
    env,
    encoding: "utf8",
    windowsVerbatimArguments: run.verbatim,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), args);
  // And a program that is no script, the same.
  const direct = launch(process.execPath, [join(dir, "show.js"), ...args], { env });
  assert.equal(direct.verbatim, false);
  const d = spawnSync(direct.command, direct.args, { encoding: "utf8" });
  assert.deepEqual(JSON.parse(d.stdout), args);
});
