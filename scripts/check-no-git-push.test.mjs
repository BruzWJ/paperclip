import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW_MARKER,
  GIT_PUSH_PATTERNS,
  collectScannableFiles,
  findGitPushOffenses,
  runCheck,
} from "./check-no-git-push.mjs";

test("regex matches common git push forms", () => {
  const shellPattern = GIT_PUSH_PATTERNS[0];
  assert.ok(shellPattern.test("git push"));
  assert.ok(shellPattern.test("GIT PUSH"));
  assert.ok(shellPattern.test("git  push origin master"));
  assert.ok(shellPattern.test("git-push"));
  assert.ok(shellPattern.test("git_push"));
});

test("regex ignores unrelated `push` usages", () => {
  const shellPattern = GIT_PUSH_PATTERNS[0];
  assert.ok(!shellPattern.test("args.push('git')"));
  assert.ok(!shellPattern.test("notes.push('git remote')"));
  assert.ok(!shellPattern.test("pushed"));
  assert.ok(!shellPattern.test("git fetch"));
});

test("findGitPushOffenses flags a bare invocation in a string", () => {
  const text = `await exec("git push origin master");\n`;
  const offenses = findGitPushOffenses(text);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
});

test("findGitPushOffenses ignores mentions inside `//` comments", () => {
  const text = `// sync-back alone — no \`git push\`, no fetch from any origin.\nconst x = 1;\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses allows opt-in marker on the same line", () => {
  const text = `await exec("git push origin master"); // ${ALLOW_MARKER}: operator-configured release mirror\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses allows opt-in marker on the line above", () => {
  const text = `// ${ALLOW_MARKER}: operator-configured release mirror\nawait exec("git push origin master");\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses flags string-literal push even when text is split across mixed quotes", () => {
  const text = "const cmd = `git push --tags`;\n";
  const offenses = findGitPushOffenses(text);
  assert.equal(offenses.length, 1);
});

test("findGitPushOffenses flags args-array form passed to spawn/execFile", () => {
  const cases = [
    `spawn("git", ["push", "origin", "main"]);\n`,
    `execFile('git', ['push', '--tags']);\n`,
    "execFile(`git`, [`push`, `--mirror`]);\n",
  ];
  for (const text of cases) {
    const offenses = findGitPushOffenses(text);
    assert.equal(offenses.length, 1, `expected match for ${text}`);
  }
});

test("findGitPushOffenses ignores `git push` in a comment after a string ending with a literal backslash", () => {
  // The closing `"` after `\\` should end the string (even literal count of
  // backslashes leaves the quote unescaped), so the `// git push` that
  // follows is comment text and must be stripped.
  const text = 'const path = "C:\\\\"; // git push origin master\nconst y = 2;\n';
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("findGitPushOffenses does not flag args-array form when allow marker is present", () => {
  const text = `// ${ALLOW_MARKER}: release tooling adapter\nspawn("git", ["push", "origin", "main"]);\n`;
  assert.deepEqual(findGitPushOffenses(text), []);
});

test("runCheck passes when scoped tree has no offenses", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "no-git-push-pass-"));
  try {
    mkdirSync(path.join(tmpRoot, "packages/adapter-utils/src"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapter-utils/src/index.ts"),
      "export const ok = 1;\n",
    );
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapter-utils"],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 0);
    assert.equal(errors.length, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck fails when scoped tree contains an unapproved git push", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "no-git-push-fail-"));
  try {
    mkdirSync(path.join(tmpRoot, "packages/adapter-utils/src"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "packages/adapter-utils/src/index.ts"),
      "import { execSync } from 'node:child_process';\nexecSync('git push origin main');\n",
    );
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapter-utils"],
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("packages/adapter-utils/src/index.ts:2")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck ignores opt-in marker outside the scoped tree", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "no-git-push-scope-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "scripts/release.mjs"),
      "execSync('git push origin v1.2.3');\n",
    );
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["packages/adapter-utils", "apps/server/src"],
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("collectScannableFiles skips node_modules, dist, and .d.ts", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "no-git-push-collect-"));
  try {
    const runtimeRoot = path.join(tmpRoot, "packages/adapter-utils");
    mkdirSync(path.join(runtimeRoot, "src"), { recursive: true });
    mkdirSync(path.join(runtimeRoot, "dist"), { recursive: true });
    mkdirSync(path.join(runtimeRoot, "node_modules/pkg"), { recursive: true });
    writeFileSync(path.join(runtimeRoot, "src/index.ts"), "");
    writeFileSync(path.join(runtimeRoot, "src/types.d.ts"), "");
    writeFileSync(path.join(runtimeRoot, "dist/index.js"), "");
    writeFileSync(path.join(runtimeRoot, "node_modules/pkg/index.js"), "");

    const files = collectScannableFiles(
      runtimeRoot,
      tmpRoot,
    );
    const relatives = files.map((entry) => entry.relative).sort();
    assert.deepEqual(relatives, ["packages/adapter-utils/src/index.ts"]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
