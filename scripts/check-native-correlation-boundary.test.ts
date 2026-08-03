import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  scanNativeCorrelationBoundaryFiles,
} from "./check-native-correlation-boundary.ts";

const FIXED_CORRELATION_PATH =
  "packages/adapter-utils/src/acp-subprocess/correlation.ts";
const FIXED_CORRELATION_SOURCE = readFileSync(
  new URL(
    "../packages/adapter-utils/src/acp-subprocess/correlation.ts",
    import.meta.url,
  ),
  "utf8",
);

function scan(path: string, source: string) {
  return scanNativeCorrelationBoundaryFiles([{ path, source }]);
}

test("rejects correlation fields and wire literals from public boundaries", () => {
  const fixtures = [
    ["server/src/routes/adapters.ts", "const result = { nativeCorrelationKind: kind };"],
    ["server/src/routes/openapi.ts", "const schema = z.object({ nativeCorrelation: z.unknown() });"],
    ["packages/shared/src/types/adapter.ts", "export interface PublicAdapter { nativeCorrelation?: unknown }"],
    ["ui/src/api/adapters.ts", "const kind = 'issue-execution-native/v1';"],
    ["packages/plugins/sdk/src/index.ts", "export const nativeCorrelationKind = 'leak';"],
  ] as const;

  for (const [path, source] of fixtures) {
    assert.ok(scan(path, source).length > 0, `expected ${path} to be rejected`);
  }
});

test("rejects adapter codec and generic result propagation", () => {
  const fixtures = [
    [
      "packages/adapters/example/src/index.ts",
      "export const nativeCorrelationCodec = codec;",
    ],
    [
      "packages/adapter-utils/src/issue-execution.ts",
      "export interface Result { nativeCorrelation?: unknown }",
    ],
    [
      "server/src/services/run-result.ts",
      "logger.info({ nativeCorrelation: result.nativeCorrelation });",
    ],
  ] as const;

  for (const [path, source] of fixtures) {
    assert.ok(scan(path, source).length > 0, `expected ${path} to be rejected`);
  }
});

test("allows only the fixed ACP envelope literal in its canonical owner", () => {
  assert.deepEqual(
    scan(FIXED_CORRELATION_PATH, FIXED_CORRELATION_SOURCE),
    [],
  );

  const extraField = `${FIXED_CORRELATION_SOURCE}\nexport const nativeCorrelation = true;\n`;
  assert.deepEqual(
    scan(FIXED_CORRELATION_PATH, extraField).map(({ term }) => term),
    ["nativeCorrelation"],
  );

  const duplicateLiteral = `${FIXED_CORRELATION_SOURCE}\nconst duplicate = "issue-execution-native/v1";\n`;
  assert.equal(
    scan(FIXED_CORRELATION_PATH, duplicateLiteral).filter(
      ({ term }) => term === "issue-execution-native/v1",
    ).length,
    2,
  );
});

test("ACP client and event boundaries cannot transport correlation fields", () => {
  for (const path of [
    "packages/adapter-utils/src/acp-subprocess/client.ts",
    "packages/adapter-utils/src/acp-subprocess/events.ts",
    "server/src/services/issue-execution-plan-live.ts",
  ]) {
    const violations = scan(
      path,
      "export const update = { nativeCorrelation: 'opaque' };",
    );
    assert.deepEqual(
      violations.map(({ term }) => term),
      ["nativeCorrelation"],
      `expected ${path} to reject correlation transport`,
    );
  }
});

test("fixed envelope literal cannot move to another internal service", () => {
  const violations = scan(
    "server/src/services/native-correlation.ts",
    'const envelopeVersion = "issue-execution-native/v1";',
  );
  assert.deepEqual(
    violations.map(({ term }) => term),
    ["issue-execution-native/v1"],
  );
});
