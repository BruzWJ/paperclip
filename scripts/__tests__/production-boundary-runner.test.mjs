import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PRODUCTION_BOUNDARY_STEPS } from "../run-production-boundaries.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("the production-boundary runner owns one concrete command graph", () => {
  const names = PRODUCTION_BOUNDARY_STEPS.map(({ name }) => name);
  assert.equal(names[0], "check:opencode-session-donor");
  assert.equal(new Set(names).size, names.length);

  for (const boundary of PRODUCTION_BOUNDARY_STEPS) {
    assert.equal(boundary.executable, process.execPath);
    assert.ok(boundary.args.length > 0, `${boundary.name} has no command`);
    const source = boundary.args.find((argument) =>
      argument.startsWith(REPOSITORY_ROOT),
    );
    assert.ok(source, `${boundary.name} has no repository-owned source`);
    assert.ok(existsSync(source), `${boundary.name} source is missing: ${source}`);
  }

  const packageJson = JSON.parse(
    readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["check:production-boundaries"],
    "node scripts/run-production-boundaries.mjs",
  );
  for (const name of names) {
    assert.equal(
      packageJson.scripts[name],
      undefined,
      `${name} must not duplicate the aggregate runner in package.json`,
    );
  }
});

test("the production-boundary runner rejects partial execution", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPOSITORY_ROOT, "scripts/run-production-boundaries.mjs"),
      "--only",
      "check:canonical-human-auth",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Production-boundary verification is atomic and does not accept a subset selector/,
  );
});
