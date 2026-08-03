import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanZeroDatabaseTests } from "./check-zero-database-tests.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-zero-db-gate-"));
  for (const directory of [
    ".github/workflows",
    "packages/example/src",
    "packages/db",
    "server/src",
    "tests/e2e",
    "ui",
  ]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  writeFileSync(
    path.join(root, ".github/workflows/pr.yml"),
    "jobs:\n  tests:\n    steps:\n      - run: pnpm test\n",
  );
  writeFileSync(
    path.join(root, "packages/example/src/service.test.ts"),
    'import { vi } from "vitest";\nvi.mock("postgres", () => ({ default: vi.fn() }));\nvi.mock("@paperclipai/db", () => ({ createDb: vi.fn() }));\nimport postgres from "postgres";\nimport { createDb } from "@paperclipai/db";\nvoid postgres; void createDb;\n',
  );
  writeFileSync(
    path.join(root, "tests/e2e/playwright.config.ts"),
    "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n",
  );
  writeFileSync(
    path.join(root, "vitest.config.ts"),
    "export default { envDir: false, test: {} };\n",
  );
  writeFileSync(
    path.join(root, "ui/vite.config.ts"),
    "export default { server: { proxy: { '/api': 'http://localhost:3100' } } };\n",
  );
  writeFileSync(
    path.join(root, "ui/vite.e2e.config.ts"),
    "export default { envDir: false, server: {} };\n",
  );
  writeFileSync(
    path.join(root, ".dockerignore"),
    ".env\n.env.*\n**/.env\n**/.env.*\n!.env.example\n!.env.*.example\n!**/.env.example\n!**/.env.*.example\n",
  );
  writeFileSync(
    path.join(root, "packages/db/runtime-config.ts"),
    "export function resolveDatabaseTarget() { return { connectionString: 'postgres://configured.invalid/paperclip' }; }\n",
  );
  writeFileSync(
    path.join(root, "server/src/config.ts"),
    "export function loadConfig() { return {}; }\n",
  );
  writeFileSync(
    path.join(root, "server/src/runtime-environment.ts"),
    "import { config as loadDotenv } from 'dotenv';\nexport function loadRuntimeEnvironmentFiles() { loadDotenv(); }\n",
  );
  return root;
}

test("accepts explicit client mocks and database-free browser/workflow wiring", () => {
  const root = fixture();
  try {
    assert.deepEqual(scanZeroDatabaseTests(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects direct and shell-invoked package smoke targets", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        name: "fixture",
        scripts: {
          "smoke:direct": "./scripts/direct-smoke.sh",
          "smoke:shell": "bash \"scripts/shell-smoke.sh\"",
          "smoke:node": "node scripts/static-smoke.mjs",
        },
      }, null, 2)}\n`,
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.equal(
      violations.match(/registers smoke validation through a shell target/g)?.length,
      2,
    );
    assert.doesNotMatch(violations, /smoke:node/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects retired live-smoke files, references, and database environment contracts", () => {
  const root = fixture();
  try {
    const retiredPath = ["scripts", "docker-onboard-smoke.sh"].join("/");
    const retiredEnvironment = ["SMOKE", "DATABASE", "URL"].join("_");
    const retiredAbsolute = path.join(root, retiredPath);
    mkdirSync(path.dirname(retiredAbsolute), { recursive: true });
    writeFileSync(retiredAbsolute, `${retiredEnvironment}=postgres://fixture.invalid/live\n`);
    mkdirSync(path.join(root, "doc"), { recursive: true });
    writeFileSync(
      path.join(root, "doc", "RELEASING.md"),
      `Run \`${retiredPath}\` before release.\n`,
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /retains a retired live validation harness/);
    assert.match(violations, /references the retired live validation path/);
    assert.match(violations, /retired test database environment contract/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a live harness at the root of the TradingGoose-style DB package", () => {
  const root = fixture();
  try {
    const harnessName = ["test", "postgres"].join("-");
    writeFileSync(
      path.join(root, "packages/db", `${harnessName}.ts`),
      "export {};\n",
    );

    assert.ok(
      scanZeroDatabaseTests(root).some(
        (violation) =>
          violation ===
          `packages/db/${harnessName}.ts:1 retains the live PostgreSQL test harness`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects command-like shell smoke instructions in active docs and skills", () => {
  const root = fixture();
  try {
    const skillDirectory = path.join(root, ".agents", "skills", "release");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(
      path.join(skillDirectory, "SKILL.md"),
      "Run `./scripts/release-candidate-smoke.sh` before publishing.\n",
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /documents a shell smoke path instead of the canonical mocked or artifact validation owner/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects database connectivity and lifecycle commands in automated package scripts", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "package.json"),
      `${JSON.stringify({
        name: "fixture",
        scripts: {
          "test:live": "export DATABASE_URL=postgres://fixture.invalid/live && pnpm db:migrate && psql -c 'select 1'",
        },
      }, null, 2)}\n`,
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /supplies database connectivity from automated package script/);
    assert.match(violations, /runs a database migration from automated package script/);
    assert.match(violations, /runs a database lifecycle\/client command in automated package script/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects production test-database tombstones but accepts inert test-local fake URLs", () => {
  const root = fixture();
  try {
    const suffix = ["TEST", "DATABASE", "URL"].join("_");
    writeFileSync(
      path.join(root, "packages/example/src/runtime.ts"),
      `export const retiredEnvironmentSuffix = "${suffix}";\n`,
    );
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      `const ${suffix} = "postgresql://fixture.invalid/inert";\nvoid ${suffix};\n`,
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(
      violations,
      /runtime\.ts:1 retains the retired production test-database environment tombstone/,
    );
    assert.doesNotMatch(violations, /service\.test\.ts.*environment tombstone/);

    writeFileSync(path.join(root, "packages/example/src/runtime.ts"), "export {};\n");
    assert.deepEqual(scanZeroDatabaseTests(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects live clients, harnesses, lifecycle SQL, server boot, and workflow services", () => {
  const root = fixture();
  try {
    const retiredEnvironmentName = [
      "PAPERCLIP",
      "TEST",
      "DATABASE",
      "URL",
    ].join("_");
    const retiredHarnessName = [
      "start",
      "External",
      "Postgres",
      "Test",
      "Database",
    ].join("");
    const lifecycleSql = ["CREATE", "DATABASE", "live_test"].join(" ");
    writeFileSync(
      path.join(root, ".github/workflows/pr.yml"),
      `jobs:\n  tests:\n    services:\n      postgres:\n        image: postgres:17-alpine\n    env:\n      ${retiredEnvironmentName}: postgres://fixture.invalid/postgres\n`,
    );
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      `import postgres from "postgres";\nimport { createDb } from "@paperclipai/db";\nconst helper = ${retiredHarnessName};\nconst sql = "${lifecycleSql}";\nvoid postgres; void createDb; void helper; void sql;\n`,
    );
    writeFileSync(
      path.join(root, "tests/e2e/playwright.config.ts"),
      "export default { webServer: { command: 'pnpm paperclipai onboard --yes --run && vite', env: { ...process.env } } };\n",
    );
    writeFileSync(
      path.join(root, "tests/e2e/unsafe.spec.ts"),
      "test('unsafe request', async ({ page }) => { await page.request.get('/api/companies'); });\n",
    );
    writeFileSync(
      path.join(root, "ui/vite.config.ts"),
      "const isTestMode = mode === 'test';\nexport default { plugins: [isTestMode && { configureServer(server) { server.middlewares.use('/api', (_request, response) => response.end()); } }], server: { proxy: { '/api': 'http://localhost:3100' } } };\n",
    );
    mkdirSync(path.join(root, "server/src/__tests__/helpers"), { recursive: true });
    writeFileSync(
      path.join(root, "server/src/__tests__/helpers/external-postgres.ts"),
      "export {};\n",
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /PostgreSQL service\/container/);
    assert.match(violations, /retired test database environment contract/);
    assert.match(violations, /without an explicit test-boundary module mock/);
    assert.match(violations, /imports a live database client or lifecycle entrypoint without an explicit test-boundary/);
    assert.match(violations, /removed live PostgreSQL test harness/);
    assert.match(violations, /creates or drops a database/);
    assert.match(violations, /boots the real Paperclip server/);
    assert.match(violations, /page\.request, which bypasses the test-owned API fixture/);
    assert.match(violations, /forwards the ambient process environment/);
    assert.match(violations, /installs a Vite request interceptor/);
    assert.match(violations, /server\/src\/__tests__\/helpers\/external-postgres\.ts:1 retains/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("traverses helpers and checks reachable production subjects for database clients", () => {
  const root = fixture();
  try {
    const helperDirectory = path.join(root, "packages/example/src/helpers");
    mkdirSync(helperDirectory, { recursive: true });
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      [
        'import "./runtime.js";',
        'import "./helpers/database-boundary.js";',
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "packages/example/src/runtime.ts"),
      'import postgres from "postgres";\nvoid postgres;\n',
    );
    writeFileSync(
      path.join(helperDirectory, "database-boundary.ts"),
      'export * from "./db-client.js";\n',
    );
    writeFileSync(
      path.join(helperDirectory, "db-client.ts"),
      'import postgres from "postgres";\nvoid postgres;\n',
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(
      violations,
      /helpers\/db-client\.ts:1 imports the PostgreSQL client/,
    );
    assert.match(
      violations,
      /service\.test\.ts:1 reaches packages\/example\/src\/runtime\.ts:1, which imports the PostgreSQL client/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects database lifecycle entrypoints and client executables hidden in helpers", () => {
  const root = fixture();
  try {
    const databaseClientExecutable = ["ps", "ql"].join("");
    const databaseMigratorModule = [
      "drizzle-orm",
      "postgres-js",
      "migrator",
    ].join("/");
    const helperDirectory = path.join(root, "packages/example/src/test-support");
    mkdirSync(helperDirectory, { recursive: true });
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'import "./test-support/database-lifecycle.js";\n',
    );
    writeFileSync(
      path.join(helperDirectory, "database-lifecycle.ts"),
      [
        'import { spawn } from "node:child_process";',
        'import { createDb } from "@paperclipai/db";',
        `import { migrate } from "${databaseMigratorModule}";`,
        `spawn("${databaseClientExecutable}", []);`,
        'void createDb; void migrate;',
      ].join("\n"),
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(
      violations,
      /test-support\/database-lifecycle\.ts:2 imports a live database client or lifecycle entrypoint/,
    );
    assert.match(
      violations,
      /test-support\/database-lifecycle\.ts:3 imports the PostgreSQL migrator/,
    );
    assert.match(
      violations,
      /test-support\/database-lifecycle\.ts:4 invokes a PostgreSQL lifecycle\/client executable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a reachable helper whose PostgreSQL client is explicitly mocked", () => {
  const root = fixture();
  try {
    const helperDirectory = path.join(root, "packages/example/src/test-utils");
    mkdirSync(helperDirectory, { recursive: true });
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'import "./test-utils/mock-client.js";\n',
    );
    writeFileSync(
      path.join(helperDirectory, "mock-client.ts"),
      [
        'import { vi } from "vitest";',
        'vi.mock("postgres", () => ({ default: vi.fn() }));',
        'import postgres from "postgres";',
        'void postgres;',
      ].join("\n"),
    );

    assert.deepEqual(scanZeroDatabaseTests(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts a reachable production subject when the test boundary mocks its client", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      [
        'import { vi } from "vitest";',
        'vi.mock("postgres", () => ({ default: vi.fn() }));',
        'import "./runtime.js";',
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "packages/example/src/runtime.ts"),
      'import postgres from "postgres";\nvoid postgres;\n',
    );

    assert.deepEqual(scanZeroDatabaseTests(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects embedded engines assembled as an escape-case fixture", () => {
  const root = fixture();
  try {
    const prohibitedDriver = ["@electric-sql", ["pg", "lite"].join("")].join("/");
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      `import { Database } from "${prohibitedDriver}";\nvoid Database;\n`,
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /uses a prohibited embedded or in-memory database engine/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects production runtime test branches and import-time dotenv loading", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/db/runtime-config.ts"),
      "export function resolveDatabaseTarget() { if (process.env.NODE_ENV === 'test') throw new Error('blocked'); return {}; }\n",
    );
    writeFileSync(
      path.join(root, "server/src/config.ts"),
      "import { config as loadDotenv } from 'dotenv';\nloadDotenv();\nexport function loadConfig() { return {}; }\n",
    );
    writeFileSync(
      path.join(root, "server/src/runtime-environment.ts"),
      "export function loadRuntimeEnvironmentFiles({ nodeEnv = process.env.NODE_ENV } = {}) { if (nodeEnv === 'test') return; }\n",
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(
      violations,
      /packages\/db\/runtime-config\.ts:1 branches production database\/config loading on test mode/,
    );
    assert.match(
      violations,
      /server\/src\/runtime-environment\.ts:1 branches production database\/config loading on test mode/,
    );
    assert.match(
      violations,
      /server\/src\/config\.ts:1 loads environment files from an importable configuration module/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects dotenv-enabled Vitest configs and incomplete Docker exclusions", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "vitest.config.ts"),
      "export default { test: {} };\n",
    );
    writeFileSync(path.join(root, ".dockerignore"), "node_modules\n.env\n");

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /vitest\.config\.ts:1 permits Vite\/Vitest dotenv auto-loading/);
    assert.match(violations, /\.dockerignore:1 must exclude \.env\.local/);
    assert.match(violations, /\.dockerignore:1 must exclude nested\/\.env/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects namespace access to a live database export", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'import * as db from "@paperclipai/db";\nvoid db.createDb;\n',
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /imports a live database client or lifecycle entrypoint/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects re-exporting a live database entrypoint", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'export { createDb } from "@paperclipai/db";\n',
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /imports a live database client or lifecycle entrypoint/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects database-identity lifecycle exports from root and subpath imports", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      [
        'import { probeDatabaseIdentity } from "@paperclipai/db";',
        'import { revalidateDatabaseIdentity } from "@paperclipai/db";',
        'void probeDatabaseIdentity; void revalidateDatabaseIdentity;',
      ].join("\n"),
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /service\.test\.ts:1 imports a live database client/);
    assert.match(violations, /service\.test\.ts:2 imports a live database client/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not treat doMock as a hoisted static-import database boundary", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      [
        'import { vi } from "vitest";',
        'vi.doMock("postgres", () => ({ default: vi.fn() }));',
        'import "./runtime.js";',
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "packages/example/src/runtime.ts"),
      'import postgres from "postgres";\nvoid postgres;\n',
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /reaches packages\/example\/src\/runtime\.ts:1, which imports the PostgreSQL client/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires a helper mock to evaluate before the database-bound subject", () => {
  const root = fixture();
  try {
    const helperDirectory = path.join(root, "packages/example/src/test-support");
    mkdirSync(helperDirectory, { recursive: true });
    writeFileSync(
      path.join(helperDirectory, "mock-postgres.ts"),
      'import { vi } from "vitest";\nvi.mock("postgres", () => ({ default: vi.fn() }));\n',
    );
    writeFileSync(
      path.join(root, "packages/example/src/runtime.ts"),
      'import postgres from "postgres";\nvoid postgres;\n',
    );
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'import "./runtime.js";\nimport "./test-support/mock-postgres.js";\n',
    );
    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /reaches packages\/example\/src\/runtime\.ts:1, which imports the PostgreSQL client/,
    );

    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'import "./test-support/mock-postgres.js";\nimport "./runtime.js";\n',
    );
    assert.deepEqual(scanZeroDatabaseTests(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects arrow-form Vite request interceptors", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "ui/vite.config.ts"),
      "export default { plugins: [{ configureServer: (server) => server.middlewares.use('/api', () => {}) }] };\n",
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /installs a Vite request interceptor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires envDir false on the exported Vitest config object", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "vitest.config.ts"),
      "// envDir: false\nconst decoy = { envDir: false };\nvoid decoy;\nexport default { test: {} };\n",
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /permits Vite\/Vitest dotenv auto-loading/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires every Playwright Vite launcher to select the e2e config", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "tests/e2e/playwright.config.ts"),
      "export default { webServer: { command: 'npx vite --host 127.0.0.1' } };\n",
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /starts Vite without the dotenv-free browser-test config/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluates Dockerignore rules in order and rejects dotenv reinclusion", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, ".dockerignore"),
      ".env\n.env.*\n**/.env\n**/.env.*\n!.env.example\n!.env.*.example\n!**/.env.example\n!**/.env.*.example\n!.env\n",
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /must exclude \.env after ordered rule evaluation/);
    assert.match(violations, /re-includes dotenv files outside the exact \.example allowlist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a sensitive mock factory that reaches the real implementation", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      [
        'import { vi } from "vitest";',
        'vi.mock("postgres", async (importOriginal) => importOriginal());',
        'import "./runtime.js";',
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "packages/example/src/runtime.ts"),
      'import postgres from "postgres";\nvoid postgres;\n',
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /reaches packages\/example\/src\/runtime\.ts:1, which imports the PostgreSQL client/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects direct test-runner access to an actual database driver", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      [
        'import { vi } from "vitest";',
        'vi.mock("postgres", () => ({ default: vi.fn() }));',
        'await vi.importActual("postgres");',
      ].join("\n"),
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /imports the PostgreSQL client without an explicit test-boundary module mock/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects direct node-postgres client access", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'import pg from "pg";\nawait new pg.Client().connect();\n',
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /imports the PostgreSQL client without an explicit test-boundary module mock/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects dotenv side effects in a database-capable test graph", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      [
        'import "dotenv/config";',
        'import { Client } from "pg";',
        'await new Client({ connectionString: process.env.DATABASE_URL }).connect();',
      ].join("\n"),
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /loads dotenv from an automated test graph/);
    assert.match(violations, /imports the PostgreSQL client/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves computed constant database driver imports", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "packages/example/src/service.test.ts"),
      'const prefix = "post";\nconst driver = prefix + "gres";\nawait import(driver);\n',
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /imports the PostgreSQL client without an explicit test-boundary module mock/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parses quoted workflow images, shell database input, migrations, and docker runs", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, ".github/workflows/pr.yml"),
      [
        "jobs:",
        "  tests:",
        "    services:",
        "      database:",
        "        image: \"postgres:17\"",
        "    steps:",
        "      - run: |",
        "          export DATABASE_URL=postgres://fixture.invalid/test",
        "          pnpm db:migrate",
        "      - run: docker run --rm 'postgres:17'",
      ].join("\n"),
    );

    const violations = scanZeroDatabaseTests(root).join("\n");
    assert.match(violations, /starts a PostgreSQL service\/container/);
    assert.match(violations, /supplies database connectivity from an automated workflow shell command/);
    assert.match(violations, /runs a database migration from an automated workflow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects production test-mode branches anywhere in first-party runtime source", () => {
  const root = fixture();
  try {
    const serviceDirectory = path.join(root, "server/src/services");
    mkdirSync(serviceDirectory, { recursive: true });
    writeFileSync(
      path.join(serviceDirectory, "database-adapter.ts"),
      "export const repository = process.env.NODE_ENV === 'test' ? fakeRepository : postgresRepository;\n",
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /server\/src\/services\/database-adapter\.ts:1 branches production database\/config loading on test mode/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("traverses Vite plugin imports for hidden request interceptors", () => {
  const root = fixture();
  try {
    writeFileSync(
      path.join(root, "ui/vite.config.ts"),
      "import { apiPlugin } from './vite-api-plugin.js';\nexport default { plugins: [apiPlugin] };\n",
    );
    writeFileSync(
      path.join(root, "ui/vite-api-plugin.ts"),
      "export const apiPlugin = { configureServer: (server) => server.middlewares.use('/api', () => {}) };\n",
    );

    assert.match(
      scanZeroDatabaseTests(root).join("\n"),
      /reaches ui\/vite-api-plugin\.ts, which installs a Vite request interceptor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
