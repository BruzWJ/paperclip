import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { skillChannelBoundaryViolations } from "./check-skill-channel-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-skill-channel-gate-"));
  roots.add(root);
  write(
    root,
    "packages/adapter-utils/src/selected-company-skills.ts",
    [
      "type SelectedCompanySkillMaterializationIdentity = { companyId: string; agentId: string; executionTargetIdentity: string; adapterConfigRevisionId: string };",
      "type Channel = { channel: \"operator_native\" } | { channel: \"isolated_skills_home\" };",
      "const MATERIALIZED_COMPANY_SKILL_SENTINEL = '.paperclip-materialized-skill.json';",
      "const selectedSetDigest = ''; const sourceFingerprint = ''; const contentDigest = '';",
      'const pinnedName = exactRuntimeName(key.split("/") as any);',
      'const staleLockMs = 1; const temporary = ".tmp-";',
      "async function installedManifest() {} async function quarantine() {}",
      "async function targetOperation(fs: any, homeDir: string) {",
      "  const operation = 'verify_after_reap';",
      '  if (input.operation === "collect") return;',
      "  async function collectExact() {}",
      "  await fs.rename(temporary, homeDir);",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/adapter-utils/src/acp-subprocess/execution-target.ts",
    [
      "declare function prepareSelectedCompanySkillTargetHome(value: unknown): Promise<unknown>;",
      "declare function resolveTargetReadOnlyBinder(value: unknown): Promise<unknown>;",
      "declare function adapterExecutionTargetIsCommandManaged(value: unknown): boolean;",
      "async function prepare(input: any, target: any, home: any) {",
      "  if (input.companySkills.channel === \"isolated_skills_home\") {",
      "    await resolveTargetReadOnlyBinder({ target });",
      "    await prepareSelectedCompanySkillTargetHome({ target });",
      "    const onFirstStdoutChunk = () => home.releasePreparationLock();",
      "    const args = [\"--ro-bind\", home.skillsDir, \"--remount-ro\", \"--cap-drop\", \"--disable-userns\"];",
      "  }",
      "  if (target.transport === \"ssh\") return;",
      "  adapterExecutionTargetIsCommandManaged(target);",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-prompt-cycle-postgres.ts",
    [
      "const issueExecutionSessions = {};",
      "const promptCycle = {",
      "  async activatePrompt(input: any) {",
      "    await options.database.transaction(async (transaction: any) => {",
      "      await resolveCompanySkillMaterializationRevisionInTransaction(input);",
      "      await fenceCompanySkillMaterializationReferenceInTransaction(transaction, input);",
      "      await transaction.insert(issueExecutionSessions);",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/company-skill-materialization-lifecycle.ts",
    [
      "const issueExecutionSessions = {};",
      "const companySkillVersions = { fileInventory: null };",
      'const CORRELATIONS = ["eligible", "current"];',
      "async function resolveCompanySkillMaterializationRevisionInTransaction(acpConfiguration: any) {",
      '  if (acpConfiguration.skillChannel === "operator_native") return;',
      "  acpConfiguration.companySkillPins;",
      "  companySkillVersions.fileInventory;",
      "}",
      "async function fenceCompanySkillMaterializationReferenceInTransaction() { pg_advisory_xact_lock(); }",
      "async function collectCompanySkillMaterializationIfUnreferencedInTransaction(candidate: any, resolved: any) {",
      "  await hasActiveIssueExecutionAttemptForMaterializationInTransaction({});",
      "  return candidate.collectExact(resolved.materializationKey);",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-run-service.ts",
    [
      "const issueExecutionAttempts = {}; const issueExecutionRuns = {};",
      "async function hasActiveIssueExecutionAttemptForMaterializationInTransaction() {",
      '  const states = ["pending", "leased", "running",];',
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    [
      "const issueExecutionAttempts = {};",
      "async function createRunningLease(transaction: any) {",
      "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});",
      "  await transaction.insert(issueExecutionAttempts);",
      "}",
      "async function createTargetNotFoundSuccessorAttempt(transaction: any) {",
      "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});",
      "  await transaction.insert(issueExecutionAttempts);",
      "}",
      "const repository = {",
      "  async markRetryable(input: any) {",
      "    await options.database.transaction(async (transaction: any) => {",
      "      await releaseAttempt(transaction);",
      '      if (input.reason === "target_not_found_new_session") {',
      "        await createTargetNotFoundSuccessorAttempt(transaction);",
      "      } else {",
      "        await scheduleIssueExecutionAttemptRetryInTransaction(transaction);",
      "      }",
      "      await collectCompanySkillMaterializationIfUnreferencedInTransaction(transaction, input.materialization);",
      "    });",
      "  },",
      "  async markTerminal(input: any) {",
      "    const settlement = await options.database.transaction(async (transaction: any) => {",
      "      await releaseAttempt(transaction);",
      "      let completed: any;",
      "      if (cancellation) {",
      "        completed = { finalization: null, laneReleased: false };",
      "      } else {",
      "        completed = await completeTerminalPromptInTransaction(transaction);",
      "      }",
      "      await collectCompanySkillMaterializationIfUnreferencedInTransaction(transaction, input.materialization);",
      "      return completed;",
      "    });",
      "    return settlement;",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/issue-execution-attempt-retry-schedule-postgres.ts",
    [
      "const issueExecutionAttempts = {};",
      "async function claimIssueExecutionAttemptRetryInTransaction(transaction: any) {",
      "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});",
      "  await transaction.insert(issueExecutionAttempts);",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "server/src/services/agent-adapter-config-revisions.ts",
    [
      "function replace(currentRevision: any, requestedPins: any, requestedSkillChannel: any) {",
      "  currentRevision.acpConfiguration;",
      "  return { companySkillPins: requestedPins, skillChannel: requestedSkillChannel };",
      "}",
      "",
    ].join("\n"),
  );
  for (const path of [
    "server/src/services/issue-execution-attempt-executor.ts",
    "server/src/services/company-skills.ts",
    "packages/adapter-utils/src/server-utils.ts",
  ]) {
    write(root, path, "export {};\n");
  }
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts the immutable revision and target-scoped read-only channel", () => {
  assert.deepEqual(skillChannelBoundaryViolations(fixtureRoot()), []);
});

test("rejects a provider-visible runtime name derived from mutable display metadata", () => {
  const root = fixtureRoot();
  const path = "packages/adapter-utils/src/selected-company-skills.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      'const pinnedName = exactRuntimeName(key.split("/")',
      'const pinnedName = exactRuntimeName(slug.split("/")',
    ),
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("pinnedName"),
    ),
  );
});

test("rejects releasing the target lock without a first-output bind signal", () => {
  const root = fixtureRoot();
  const path = "packages/adapter-utils/src/acp-subprocess/execution-target.ts";
  write(
    root,
    path,
    readFileSync(join(root, path), "utf8").replace(
      "onFirstStdoutChunk",
      "releaseImmediatelyAfterSpawn",
    ),
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("onFirstStdoutChunk"),
    ),
  );
});

test("rejects propagating raw target diagnostics from the materializer", () => {
  const root = fixtureRoot();
  const path = "packages/adapter-utils/src/selected-company-skills.ts";
  write(
    root,
    path,
    `${readFileSync(join(root, path), "utf8")}\nconst leaked = result.stderr;\n`,
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("raw target diagnostics"),
    ),
  );
});

for (const retired of [
  "WorkspaceSelectedCompanySkillExposure",
  "workspaceExposureTails",
  "acquireWorkspaceExposure",
  "exposeSelectedCompanySkillsInWorkspace",
  "PAPERCLIP_EXPOSURE_NAME_FRAGMENT",
  "selectedCompanySkillExposure",
  "IssueExecutionCompanySkillMaterializer",
  "createPostgresIssueExecutionCompanySkillMaterializer",
  "listRuntimeSkillEntries",
  "CompanySkillRuntimeEntry",
  "CompanySkillSelectionEntry",
  "paperclipSkillSync",
  "desiredSkills",
] as const) {
  test(`rejects retired skill-channel identifier ${retired}`, () => {
    const root = fixtureRoot();
    const path = "server/src/services/company-skills.ts";
    write(root, path, `const ${retired} = true;\n`);
    assert.ok(
      skillChannelBoundaryViolations(root).some((violation) =>
        violation.includes(retired),
      ),
    );
  });
}

test("rejects a runtime .agents/skills write", () => {
  const root = fixtureRoot();
  const path = "server/src/services/company-skills.ts";
  write(
    root,
    path,
    'async function expose(fs: any) { await fs.writeFile(".agents/skills/review/SKILL.md", "x"); }\n',
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("writes into runtime .agents/skills"),
    ),
  );
});

test("rejects a writable discovery bind", () => {
  const root = fixtureRoot();
  const path =
    "packages/adapter-utils/src/acp-subprocess/execution-target.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(root, path, original.replace('"--ro-bind"', '"--bind"'));
  const violations = skillChannelBoundaryViolations(root);
  assert.ok(
    violations.some((violation) =>
      violation.includes("writable selected-skill bind") ||
      violation.includes("missing canonical ownership token"),
    ),
  );
});

test("rejects skill I/O before the isolated channel guard", () => {
  const root = fixtureRoot();
  const path =
    "packages/adapter-utils/src/acp-subprocess/execution-target.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    original.replace(
      "async function prepare(input: any, target: any, home: any) {",
      "async function prepare(input: any, target: any, home: any) {\n  await prepareSelectedCompanySkillTargetHome({ target });",
    ),
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("not confined to isolated_skills_home"),
    ),
  );
});

test("rejects a local-only target materializer", () => {
  const root = fixtureRoot();
  const path = "packages/adapter-utils/src/selected-company-skills.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    `${original}\nif (target.kind !== "local") throw new Error("local only");\n`,
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("local-only materializer"),
    ),
  );
});

test("rejects an execution-scoped materialization key", () => {
  const root = fixtureRoot();
  const path = "packages/adapter-utils/src/selected-company-skills.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(root, path, `${original}\nconst attemptId = "attempt";\n`);
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("scoped by a run, attempt"),
    ),
  );
});

test("rejects a provider-visible Paperclip execution suffix", () => {
  const root = fixtureRoot();
  const path = "packages/adapter-utils/src/selected-company-skills.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(root, path, `${original}\nconst suffix = "--paperclip-deadbeef";\n`);
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("execution suffix"),
    ),
  );
});

test("rejects a parallel prompt-cycle skill selection projection", () => {
  const root = fixtureRoot();
  const path =
    "server/src/services/issue-execution-prompt-cycle-postgres.ts";
  write(
    root,
    path,
    `${readFileSync(join(root, path), "utf8")}\nconst selectedCompanySkills = [];\n`,
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("parallel or writable skill-channel surface"),
    ),
  );
});

test("rejects operator_native selection reads before its zero-I/O return", () => {
  const root = fixtureRoot();
  const path =
    "server/src/services/company-skill-materialization-lifecycle.ts";
  const original = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    original.replace(
      "async function resolveCompanySkillMaterializationRevisionInTransaction(acpConfiguration: any) {",
      "async function resolveCompanySkillMaterializationRevisionInTransaction(acpConfiguration: any) {\n  acpConfiguration.companySkillPins;",
    ),
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("does not return before selected-skill storage reads"),
    ),
  );
});

function expectSkillChannelMutation(
  path: string,
  mutate: (source: string) => string,
  expected: string,
): void {
  const root = fixtureRoot();
  const original = readFileSync(join(root, path), "utf8");
  const mutated = mutate(original);
  assert.notEqual(mutated, original, "mutation must change its fixture");
  write(root, path, mutated);
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes(expected),
    ),
  );
}

test("rejects removal of the correlation activation fence", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-prompt-cycle-postgres.ts",
    (source) => source.replace(
      "      await fenceCompanySkillMaterializationReferenceInTransaction(transaction, input);\n",
      "",
    ),
    "native-correlation activation materialization fence",
  );
});

test("rejects removal of the initial attempt fence", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) => source.replace(
      "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});\n",
      "",
    ),
    "initial attempt materialization fence",
  );
});

test("rejects removal of the target-not-found successor fence", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) => source.replace(
      [
        "async function createTargetNotFoundSuccessorAttempt(transaction: any) {",
        "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});",
      ].join("\n"),
      "async function createTargetNotFoundSuccessorAttempt(transaction: any) {",
    ),
    "target-not-found successor materialization fence",
  );
});

test("rejects removal of the scheduled-retry successor fence", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-attempt-retry-schedule-postgres.ts",
    (source) => source.replace(
      "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});\n",
      "",
    ),
    "scheduled-retry successor materialization fence",
  );
});

for (const [label, path, fence, writer, expected] of [
  [
    "native-correlation activation",
    "server/src/services/issue-execution-prompt-cycle-postgres.ts",
    "      await fenceCompanySkillMaterializationReferenceInTransaction(transaction, input);\n",
    "      await transaction.insert(issueExecutionSessions);\n",
    "native-correlation activation materialization fence",
  ],
  [
    "initial attempt",
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});\n",
    "  await transaction.insert(issueExecutionAttempts);\n",
    "initial attempt materialization fence",
  ],
  [
    "scheduled-retry successor",
    "server/src/services/issue-execution-attempt-retry-schedule-postgres.ts",
    "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});\n",
    "  await transaction.insert(issueExecutionAttempts);\n",
    "scheduled-retry successor materialization fence",
  ],
] as const) {
  test(`rejects ${label} publication before its exact fence`, () => {
    expectSkillChannelMutation(
      path,
      (source) => source
        .replace(fence, "")
        .replace(writer, `${writer}${fence}`),
      expected,
    );
  });
}

test("rejects a target-not-found successor published before its exact fence", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) => source.replace(
      [
        "async function createTargetNotFoundSuccessorAttempt(transaction: any) {",
        "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});",
        "  await transaction.insert(issueExecutionAttempts);",
      ].join("\n"),
      [
        "async function createTargetNotFoundSuccessorAttempt(transaction: any) {",
        "  await transaction.insert(issueExecutionAttempts);",
        "  await fenceCompanySkillMaterializationReferenceInTransaction(transaction, {});",
      ].join("\n"),
    ),
    "target-not-found successor materialization fence",
  );
});

test("rejects an unrelated duplicate exact-key collector", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) =>
      `${source}\nasync function fakeFifthCollector(transaction: any) {\n` +
      "  await collectCompanySkillMaterializationIfUnreferencedInTransaction(transaction, null);\n}\n",
    "owned only by markRetryable and markTerminal",
  );
});

test("rejects a retry branch that bypasses exact-key collection", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) => source.replace(
      "        await createTargetNotFoundSuccessorAttempt(transaction);\n",
      "        await createTargetNotFoundSuccessorAttempt(transaction);\n        return;\n",
    ),
    "early return",
  );
});

test("rejects collection before retry branch state changes", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) => {
      const collection =
        "      await collectCompanySkillMaterializationIfUnreferencedInTransaction(transaction, input.materialization);\n";
      return source
        .replace(collection, "")
        .replace(
          '      if (input.reason === "target_not_found_new_session") {\n',
          `${collection}      if (input.reason === "target_not_found_new_session") {\n`,
        );
    },
    "transaction-tail materialization collection",
  );
});

test("rejects a terminal cancellation branch that bypasses collection", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) => source.replace(
      "        completed = { finalization: null, laneReleased: false };\n",
      "        return { finalization: null, laneReleased: false };\n",
    ),
    "early return",
  );
});

test("rejects terminal collection inside only the non-cancellation branch", () => {
  expectSkillChannelMutation(
    "server/src/services/issue-execution-dispatcher-postgres.ts",
    (source) => {
      const collection =
        "      await collectCompanySkillMaterializationIfUnreferencedInTransaction(transaction, input.materialization);\n";
      const terminalCollectionAt = source.lastIndexOf(collection);
      assert.ok(terminalCollectionAt >= 0);
      const withoutCollection =
        source.slice(0, terminalCollectionAt) +
        source.slice(terminalCollectionAt + collection.length);
      return withoutCollection.replace(
        "        completed = await completeTerminalPromptInTransaction(transaction);\n",
        "        completed = await completeTerminalPromptInTransaction(transaction);\n" +
          "        await collectCompanySkillMaterializationIfUnreferencedInTransaction(transaction, input.materialization);\n",
      );
    },
    "one materialization collection immediately before",
  );
});

for (const [label, path, token] of [
  [
    "transaction advisory fence",
    "server/src/services/company-skill-materialization-lifecycle.ts",
    "pg_advisory_xact_lock",
  ],
  [
    "active-attempt states",
    "server/src/services/issue-execution-run-service.ts",
    '"pending",',
  ],
  [
    "eligible-correlation states",
    "server/src/services/company-skill-materialization-lifecycle.ts",
    '"eligible", "current"',
  ],
  [
    "exact target collector",
    "server/src/services/company-skill-materialization-lifecycle.ts",
    "candidate.collectExact(resolved.materializationKey)",
  ],
] as const) {
  test(`rejects removal of the ${label}`, () => {
    const root = fixtureRoot();
    const original = readFileSync(join(root, path), "utf8");
    write(root, path, original.replace(token, `removed_${token.length}`));
    assert.ok(
      skillChannelBoundaryViolations(root).some((violation) =>
        violation.includes("missing canonical ownership token"),
      ),
    );
  });
}

test("rejects age-based materialization collection", () => {
  const root = fixtureRoot();
  const path =
    "server/src/services/company-skill-materialization-lifecycle.ts";
  write(
    root,
    path,
    `${readFileSync(join(root, path), "utf8")}\nconst maxAge = 60_000;\n`,
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("uses age instead of exact reference fencing"),
    ),
  );
});

test("rejects complement-list materialization collection", () => {
  const root = fixtureRoot();
  const path =
    "server/src/services/company-skill-materialization-lifecycle.ts";
  write(
    root,
    path,
    `${readFileSync(join(root, path), "utf8")}\nfunction listMaterializations() {}\n`,
  );
  assert.ok(
    skillChannelBoundaryViolations(root).some((violation) =>
      violation.includes("uses a complement-list owner"),
    ),
  );
});
