import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function assertSuccessful(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed:\n${result.stderr || result.stdout || "no output"}`,
  );
}

test("built package metadata and artifacts resolve to the shipped entrypoints", () => {
  const rootPackage = readJson("package.json");
  const cliPackage = readJson("cli/package.json");
  const serverPackage = readJson("server/package.json");

  assert.equal(
    rootPackage.scripts?.["test:release-smoke"],
    "node scripts/run-release-smoke.mjs",
  );
  assert.equal(cliPackage.bin?.paperclipai, "./dist/index.js");
  assert.ok(cliPackage.files?.includes("dist"));
  assert.equal(serverPackage.scripts?.start, "node dist/runtime-entry.js");
  assert.equal(serverPackage.publishConfig?.main, "./dist/index.js");
  assert.equal(
    serverPackage.publishConfig?.exports?.["."]?.import,
    "./dist/index.js",
  );
  assert.ok(serverPackage.files?.includes("dist"));

  for (const relativePath of [
    "cli/dist/index.js",
    "server/dist/index.js",
    "server/dist/runtime-entry.js",
  ]) {
    assert.equal(existsSync(path.join(repoRoot, relativePath)), true, `${relativePath} is missing`);
    assertSuccessful(
      spawnSync(process.execPath, ["--check", relativePath], {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
      }),
      `${relativePath} syntax check`,
    );
  }

  const runtimeEntry = readFileSync(
    path.join(repoRoot, "server/dist/runtime-entry.js"),
    "utf8",
  );
  assert.match(runtimeEntry, /import\(["']\.\/index\.js["']\)/);
  assert.match(runtimeEntry, /startServerRuntime/);

  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /CMD \["node", "--import", "\.\/server\/node_modules\/tsx\/dist\/loader\.mjs", "server\/dist\/runtime-entry\.js"\]/,
  );
});

test("the local publishable package contains its executable entrypoint", () => {
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", "./cli"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    },
  );
  assertSuccessful(packed, "npm pack dry run");

  const result = JSON.parse(packed.stdout);
  assert.equal(result.length, 1);
  const files = new Map(result[0].files.map((file) => [file.path, file]));
  assert.deepEqual([...files.keys()].sort(), [
    "README.md",
    "dist/index.js",
    "dist/index.js.map",
    "package.json",
  ]);
  assert.ok((files.get("dist/index.js")?.mode & 0o111) !== 0);
});

test("built runtime configuration fails before startup when no external target exists", () => {
  const emptyHome = mkdtempSync(
    path.join(os.tmpdir(), "paperclip-release-config-failure-"),
  );
  try {
    const configModuleUrl = pathToFileURL(
      path.join(repoRoot, "server/dist/config.js"),
    ).href;
    const script = `const { loadConfig } = await import(${JSON.stringify(configModuleUrl)}); loadConfig();`;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repoRoot, "server/node_modules/tsx/dist/loader.mjs"),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: emptyHome,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          HOME: emptyHome,
          LANG: "C",
          NODE_ENV: "production",
          PAPERCLIP_HOME: emptyHome,
          PAPERCLIP_INSTANCE_ID: "release-smoke",
          PATH: process.env.PATH,
          TMPDIR: emptyHome,
        },
      },
    );

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /An external PostgreSQL connection is required/);
    assert.doesNotMatch(
      output,
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Server listening/,
    );
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});
