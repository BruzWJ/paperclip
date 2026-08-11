import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DONOR_COMMIT = "2b2aacc93975330f9fd045d4306f698b0c6a8f8f";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DONOR_ROOT = path.resolve(
  process.env.OPENCODE_SESSION_DONOR ??
    path.join(REPO_ROOT, "../../reference/projects/opencode"),
);
const LOCK_PATH = path.join(REPO_ROOT, "opencode-donor.lock.json");

const SCHEMA_ROOTS = [
  "packages/schema/src/session.ts",
  "packages/schema/src/session-id.ts",
  "packages/schema/src/session-message.ts",
  "packages/schema/src/session-event.ts",
  "packages/schema/src/session-input.ts",
  "packages/schema/src/session-delivery.ts",
] as const;

const SCHEMA_EXCLUSIONS = [
  "packages/schema/src/session-compaction-event.ts",
  "packages/schema/src/session-status-event.ts",
  "packages/schema/src/session-todo.ts",
  "packages/schema/src/session-v1.ts",
  "packages/schema/src/v1/legacy-event.ts",
  "packages/schema/src/v1/permission.ts",
  "packages/schema/src/v1/question.ts",
  "packages/schema/src/v1/session.ts",
] as const;

const CORE_PATHS = [
  "packages/core/src/session.ts",
  "packages/core/src/session/context-epoch.ts",
  "packages/core/src/session/error.ts",
  "packages/core/src/session/event.ts",
  "packages/core/src/session/history.ts",
  "packages/core/src/session/info.ts",
  "packages/core/src/session/input.ts",
  "packages/core/src/session/message.ts",
  "packages/core/src/session/message-updater.ts",
  "packages/core/src/session/projector.ts",
  "packages/core/src/session/prompt.ts",
  "packages/core/src/session/revert.ts",
  "packages/core/src/session/schema.ts",
  "packages/core/src/session/sql.ts",
  "packages/core/src/session/store.ts",
] as const;

const CORE_EXCLUDED_PATHS = [
  "packages/core/src/session/execution.ts",
  "packages/core/src/session/execution/local.ts",
  "packages/core/src/session/run-coordinator.ts",
  "packages/core/src/session/runner/index.ts",
  "packages/core/src/session/runner/llm.ts",
  "packages/core/src/session/runner/max-steps.ts",
  "packages/core/src/session/runner/model.ts",
  "packages/core/src/session/runner/publish-llm-event.ts",
  "packages/core/src/session/runner/to-llm-message.ts",
  "packages/core/src/session/todo.ts",
  "packages/core/src/session/compaction.ts",
  "all SessionV1, V1 table/event/create/project spans in mixed files",
] as const;

const CORE_MANIFEST_SHA256 =
  "5d57631d9d1f1179a8d87d06d69c598387f21c8001b9656aac3393ccf764b26d";

type SpanEvidence = {
  readonly symbol?: string;
  readonly kind?: string;
  readonly start: number;
  readonly end: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly sha256: string;
};

type DonorFileEvidence = {
  readonly sourcePath: string;
  readonly gitBlob: string;
  readonly sha256: string;
  readonly role?: string;
  readonly adoptedExports?: readonly SpanEvidence[];
  readonly adoptedSpans?: readonly SpanEvidence[];
  readonly excludedSpans?: readonly SpanEvidence[];
  readonly explicitExcludedSymbolsOrSpans?: readonly string[];
};

type DonorLock = {
  readonly version: number;
  readonly donor: {
    readonly repository: string;
    readonly commit: string;
  };
  readonly schema: {
    readonly roots: readonly string[];
    readonly staticRelativeClosure: readonly DonorFileEvidence[];
    readonly exclusions: readonly string[];
  };
  readonly coreV2: {
    readonly files: readonly DonorFileEvidence[];
    readonly excludedFiles: readonly string[];
  };
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const git = (args: readonly string[]): string =>
  execFileSync("git", ["-C", DONOR_ROOT, ...args], {
    encoding: "utf8",
  }).trim();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function comparable(value: unknown): string {
  return JSON.stringify(value);
}

function manifestSpan(span: SpanEvidence) {
  return {
    symbol: span.symbol,
    kind: span.kind,
    start: span.start,
    end: span.end,
    startLine: span.startLine,
    endLine: span.endLine,
    sha256: span.sha256,
  };
}

function manifestFiles(files: readonly DonorFileEvidence[]) {
  return files.map((record) => ({
    sourcePath: record.sourcePath,
    role: record.role,
    adoptedSpans: (record.adoptedSpans ?? []).map(manifestSpan),
    excludedSpans: (record.excludedSpans ?? []).map(manifestSpan),
    explicitExcludedSymbolsOrSpans:
      record.explicitExcludedSymbolsOrSpans ?? [],
  }));
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  assert(
    comparable(Object.keys(value).sort()) === comparable([...keys].sort()),
    `${label} keys changed`,
  );
}

function assertEvidence(record: DonorFileEvidence): void {
  assert(record.sourcePath.length > 0, "Donor source path is empty");
  assert(/^[0-9a-f]{40}$/.test(record.gitBlob), "Donor git blob is invalid");
  assert(/^[0-9a-f]{64}$/.test(record.sha256), "Donor sha256 is invalid");
  for (const span of [
    ...(record.adoptedExports ?? []),
    ...(record.adoptedSpans ?? []),
    ...(record.excludedSpans ?? []),
  ]) {
    assert(
      Number.isInteger(span.start) && span.start >= 0 &&
        Number.isInteger(span.end) && span.end > span.start &&
        /^[0-9a-f]{64}$/.test(span.sha256),
      `Invalid donor span evidence for ${record.sourcePath}`,
    );
  }
}

export function assertDonorLockStructure(value: unknown): asserts value is DonorLock {
  assert(value !== null && typeof value === "object", "Donor lock must be an object");
  const lock = value as DonorLock;
  exactKeys(lock, ["version", "donor", "schema", "coreV2"], "donor lock");
  assert(lock.version === 7, "Donor lock version must be 7");
  exactKeys(lock.donor, ["repository", "commit"], "donor identity");
  assert(lock.donor.repository === "reference/opencode", "Donor repository changed");
  assert(lock.donor.commit === DONOR_COMMIT, "Donor commit changed");
  exactKeys(lock.schema, ["roots", "staticRelativeClosure", "exclusions"], "schema lock");
  exactKeys(lock.coreV2, ["files", "excludedFiles"], "core lock");
  assert(comparable(lock.schema.roots) === comparable(SCHEMA_ROOTS), "Schema roots changed");
  assert(
    comparable(lock.schema.exclusions) === comparable(SCHEMA_EXCLUSIONS),
    "Schema exclusions changed",
  );
  assert(
    comparable(lock.coreV2.files.map((record) => record.sourcePath)) === comparable(CORE_PATHS),
    "Core Session file manifest changed",
  );
  assert(
    comparable(lock.coreV2.excludedFiles) === comparable(CORE_EXCLUDED_PATHS),
    "Core Session exclusion manifest changed",
  );
  assert(
    sha256(comparable(manifestFiles(lock.coreV2.files))) ===
      CORE_MANIFEST_SHA256,
    "Core Session adopted/excluded span manifest changed",
  );
  const closurePaths = lock.schema.staticRelativeClosure.map((record) => record.sourcePath);
  assert(new Set(closurePaths).size === closurePaths.length, "Schema closure has duplicate paths");
  assert(
    SCHEMA_ROOTS.every((root) => closurePaths.includes(root)),
    "Schema closure is missing a root",
  );
  assert(
    closurePaths.every((sourcePath) =>
      sourcePath.startsWith("packages/schema/src/") &&
      !SCHEMA_EXCLUSIONS.includes(sourcePath as (typeof SCHEMA_EXCLUSIONS)[number])),
    "Schema closure crossed its reviewed boundary",
  );
  for (const record of [...lock.schema.staticRelativeClosure, ...lock.coreV2.files]) {
    assertEvidence(record);
  }
}

function verifyDonorFile(record: DonorFileEvidence): void {
  const source = execFileSync(
    "git",
    ["-C", DONOR_ROOT, "show", `${DONOR_COMMIT}:${record.sourcePath}`],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  assert(
    git(["rev-parse", `${DONOR_COMMIT}:${record.sourcePath}`]) === record.gitBlob,
    `Donor blob changed: ${record.sourcePath}`,
  );
  assert(sha256(source) === record.sha256, `Donor bytes changed: ${record.sourcePath}`);
  for (const span of [
    ...(record.adoptedExports ?? []),
    ...(record.adoptedSpans ?? []),
    ...(record.excludedSpans ?? []),
  ]) {
    assert(span.end <= source.length, `Donor span escaped ${record.sourcePath}`);
    assert(
      sha256(source.slice(span.start, span.end)) === span.sha256,
      `Donor span changed: ${record.sourcePath}:${span.start}-${span.end}`,
    );
  }
}

async function main(): Promise<void> {
  const raw = await readFile(LOCK_PATH, "utf8");
  const lock = JSON.parse(raw) as unknown;
  assertDonorLockStructure(lock);
  assert(
    git(["cat-file", "-t", DONOR_COMMIT]) === "commit",
    `Session donor must contain ${DONOR_COMMIT}`,
  );
  for (const record of [...lock.schema.staticRelativeClosure, ...lock.coreV2.files]) {
    verifyDonorFile(record);
  }
  assert(raw === `${JSON.stringify(lock, null, 2)}\n`, "opencode-donor.lock.json must be canonical reviewed JSON");
  console.log("Exact OpenCode Session schema/core donor closure verified.");
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
