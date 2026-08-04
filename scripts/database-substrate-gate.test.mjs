import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  scanDatabaseSubstrateFiles,
  scanDatabaseSubstrateRepository,
} from "./database-substrate-gate.mjs";

const retiredRuntime = ["embed", "ded", "Post", "gres"].join("");
const optionalDriver = ["pg", "lite"].join("");
const peerName = ["@electric-sql", optionalDriver].join("/");
const checkName = [
  "check:no-",
  ["embed", "ded"].join(""),
  "-",
  ["post", "gres"].join(""),
].join("");

function scan(path, source) {
  return scanDatabaseSubstrateFiles([{ path, source }]);
}

test("classifies a retired runtime source", () => {
  const violations = scan("apps/server/src/runtime.ts", `const retired = \"${retiredRuntime}\";`);
  assert.deepEqual(violations.map(({ category, rule }) => ({ category, rule })), [
    { category: "source", rule: "retired-runtime" },
  ]);
});

test("rejects a resolved optional-driver package binding", () => {
  const source = `packages:\n  ${peerName}@0.3.0:\n    resolution: {}`;
  const violations = scan("pnpm-lock.yaml", source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].category, "package-resolution");
  assert.equal(violations[0].rule, "retired-driver");
});

test("does not treat an unresolved upstream peer declaration as a package resolution", () => {
  const source = [
    "packages:",
    "  upstream-library@1.0.0:",
    "    peerDependencies:",
    `      '${peerName}': '>=0.2.0'`,
    "    peerDependenciesMeta:",
    `      '${peerName}':`,
    "        optional: true",
  ].join("\n");
  assert.deepEqual(scan("pnpm-lock.yaml", source), []);
});

test("rejects a resolved peer binding in a package snapshot", () => {
  const source = [
    "snapshots:",
    `  upstream-library@1.0.0(${peerName}@0.3.0):`,
    "    dependencies: {}",
  ].join("\n");
  const violations = scan("pnpm-lock.yaml", source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].category, "package-resolution");
  assert.equal(violations[0].rule, "retired-driver");
});

test("rejects package-manager optional-peer auto-installation", () => {
  const npmrcViolations = scan(".npmrc", "auto-install-peers=true");
  assert.deepEqual(
    npmrcViolations.map(({ category, rule }) => ({ category, rule })),
    [{ category: "configuration", rule: "optional-peer-auto-install" }],
  );

  const lockViolations = scan(
    "pnpm-lock.yaml",
    "settings:\n  autoInstallPeers: true",
  );
  assert.deepEqual(
    lockViolations.map(({ category, rule }) => ({ category, rule })),
    [{ category: "package-resolution", rule: "optional-peer-auto-install" }],
  );
});

test("does not treat a Compose service URL as a generated local default", () => {
  const source = "DATABASE_URL: postgres://paperclip:paperclip@db:5432/paperclip";
  assert.deepEqual(scan("docker/docker-compose.quickstart.yml", source), []);
});

test("rejects a local runtime default", () => {
  const source = "const url = 'postgres://paperclip:paperclip@localhost:5432/paperclip';";
  const violations = scan("apps/server/src/runtime.ts", source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "default-local-target");
});

test("permits only the gate command invocation", () => {
  assert.deepEqual(
    scan(".github/workflows/pr.yml", `run: pnpm run ${checkName}`),
    [],
  );
  assert.deepEqual(
    scan(
      "scripts/run-production-boundaries.mjs",
      `const commands = ["${checkName}"];`,
    ),
    [],
  );
});

test("permits a constructed release artifact deny-list and rejects literal mutations", () => {
  const constructed = [
    "retired_runtime='embed''ded-postgres'",
    "optional_driver='pg''lite'",
    'grep -Eiq "${retired_runtime}|${optional_driver}" package-files.txt',
  ].join("\n");
  assert.deepEqual(scan(".github/workflows/release-smoke.yml", constructed), []);

  const retiredRuntimeLiteral = ["embed", "ded-postgres"].join("");
  const optionalDriverLiteral = ["pg", "lite"].join("");
  const violations = scan(
    ".github/workflows/release-smoke.yml",
    `grep -Eiq '${retiredRuntimeLiteral}|${optionalDriverLiteral}' package-files.txt`,
  );
  assert.deepEqual(
    violations.map(({ category, rule }) => ({ category, rule })),
    [
      { category: "ci", rule: "retired-runtime" },
      { category: "ci", rule: "retired-driver" },
    ],
  );
});

test("scans documentation instead of exempting it wholesale", () => {
  const violations = scan("apps/docs/deploy/database.md", `legacy: ${retiredRuntime}`);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].category, "documentation");
});

test("classifies Markdown outside doc roots as documentation", () => {
  const path = "packages/plugins/example/SMOKE.md";
  assert.deepEqual(
    scan(
      path,
      "Connect to an operator-provisioned PostgreSQL server at postgres://paperclip@127.0.0.1:5432/paperclip.",
    ),
    [],
  );

  const violations = scan(path, `legacy: ${retiredRuntime}`);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].category, "documentation");
  assert.equal(violations[0].rule, "retired-runtime");
});

test("repository traversal never reads private dotenv files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-substrate-scan-"));
  try {
    await mkdir(path.join(root, "nested"), { recursive: true });
    const forbidden = `legacy: ${retiredRuntime}`;
    await Promise.all([
      writeFile(path.join(root, ".env"), forbidden, { mode: 0o000 }),
      writeFile(path.join(root, ".env.local"), forbidden, { mode: 0o000 }),
      writeFile(path.join(root, "nested", ".env.production"), forbidden, { mode: 0o000 }),
      writeFile(path.join(root, ".env.example"), "DATABASE_URL=\n"),
      writeFile(path.join(root, "safe.ts"), "export {};\n"),
    ]);

    assert.deepEqual(await scanDatabaseSubstrateRepository(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
