import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const MATERIALIZER =
  "packages/adapter-utils/src/selected-company-skills.ts";
const TARGET_DRIVER =
  "packages/adapter-utils/src/acp-subprocess/execution-target.ts";
const ATTEMPT_EXECUTOR =
  "apps/server/src/services/issue-execution-attempt-executor.ts";
const PROMPT_CYCLE =
  "apps/server/src/services/issue-execution-prompt-cycle-postgres.ts";
const MATERIALIZATION_LIFECYCLE =
  "apps/server/src/services/company-skill-materialization-lifecycle.ts";
const RUN_SERVICE =
  "apps/server/src/services/issue-execution-run-service.ts";
const DISPATCHER =
  "apps/server/src/services/issue-execution-dispatcher-postgres.ts";
const RETRY_SCHEDULE =
  "apps/server/src/services/issue-execution-attempt-retry-schedule-postgres.ts";
const REVISION_OWNER =
  "apps/server/src/services/agent-adapter-config-revisions.ts";
const COMPANY_SKILL_OWNER = "apps/server/src/services/company-skills.ts";
const SERVER_UTILS = "packages/adapter-utils/src/server-utils.ts";

const RETIRED_IDENTIFIERS = [
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
] as const;

const MATERIALIZER_REQUIRED = [
  "SelectedCompanySkillMaterializationIdentity",
  "companyId",
  "agentId",
  "executionTargetIdentity",
  "adapterConfigRevisionId",
  "selectedSetDigest",
  'const pinnedName = exactRuntimeName(key.split("/")',
  "sourceFingerprint",
  "contentDigest",
  "MATERIALIZED_COMPANY_SKILL_SENTINEL",
  "staleLockMs",
  '".tmp-"',
  "installedManifest",
  "verify_after_reap",
  'input.operation === "collect"',
  "collectExact(",
  "quarantine",
  "fs.rename(temporary, homeDir)",
  'channel: "operator_native"',
  'channel: "isolated_skills_home"',
] as const;

const TARGET_REQUIRED = [
  'input.companySkills.channel === "isolated_skills_home"',
  "prepareSelectedCompanySkillTargetHome({",
  "resolveTargetReadOnlyBinder({",
  '"--ro-bind"',
  "home.skillsDir",
  "onFirstStdoutChunk",
  '"--remount-ro"',
  '"--cap-drop"',
  '"--disable-userns"',
  "target.transport === \"ssh\"",
  "adapterExecutionTargetIsCommandManaged(target)",
] as const;

const PROMPT_REQUIRED = [
  "resolveCompanySkillMaterializationRevisionInTransaction(",
  "fenceCompanySkillMaterializationReferenceInTransaction(",
] as const;

const LIFECYCLE_REQUIRED = [
  "resolveCompanySkillMaterializationRevisionInTransaction(",
  "fenceCompanySkillMaterializationReferenceInTransaction(",
  "collectCompanySkillMaterializationIfUnreferencedInTransaction(",
  "pg_advisory_xact_lock",
  "issueExecutionSessions",
  "hasActiveIssueExecutionAttemptForMaterializationInTransaction(",
  '"eligible", "current"',
  "candidate.collectExact(resolved.materializationKey)",
  'acpConfiguration.skillChannel === "operator_native"',
  "acpConfiguration.companySkillPins",
  "companySkillVersions.fileInventory",
] as const;

const RUN_SERVICE_REQUIRED = [
  "hasActiveIssueExecutionAttemptForMaterializationInTransaction(",
  "issueExecutionAttempts",
  "issueExecutionRuns",
  '"pending",',
  '"leased",',
  '"running",',
] as const;

const DISPATCHER_REQUIRED = [
  "fenceCompanySkillMaterializationReferenceInTransaction(",
  "collectCompanySkillMaterializationIfUnreferencedInTransaction(",
] as const;

const RETRY_REQUIRED = [
  "fenceCompanySkillMaterializationReferenceInTransaction(",
] as const;

const REVISION_REQUIRED = [
  "companySkillPins: requestedPins",
  "skillChannel: requestedSkillChannel",
  "currentRevision.acpConfiguration",
] as const;

const MATERIALIZATION_FENCE_CALL =
  "fenceCompanySkillMaterializationReferenceInTransaction";
const MATERIALIZATION_COLLECTION_CALL =
  "collectCompanySkillMaterializationIfUnreferencedInTransaction";

function read(repositoryRoot: string, path: string): string | null {
  const absolutePath = resolve(repositoryRoot, path);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null;
}

function isProductionSource(path: string): boolean {
  return (
    /\.(?:cjs|js|mjs|ts|tsx)$/.test(path) &&
    !path.includes("/__tests__/") &&
    !/\.(?:test|spec)\.[^.]+$/.test(path)
  );
}

function retiredIdentifierViolations(repositoryRoot: string): string[] {
  const violations: string[] = [];
  for (const absolutePath of listRepositoryTextFiles(repositoryRoot, [
    "packages/adapter-utils/src",
    "packages/shared/src",
    "apps/server/src",
    "apps/ui/src",
    "packages/cli/src",
  ])) {
    const path = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
    if (!isProductionSource(path)) continue;
    const source = readFileSync(absolutePath, "utf8");
    for (const identifier of RETIRED_IDENTIFIERS) {
      if (source.includes(identifier)) {
        violations.push(`${path}: retired skill-channel identifier ${identifier}`);
      }
    }
  }
  return violations;
}

type NamedFunctionLike =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration;

function sourceFile(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function namedFunctionLike(
  file: ts.SourceFile,
  name: string,
): NamedFunctionLike | null {
  let match: NamedFunctionLike | null = null;
  const visit = (node: ts.Node): void => {
    if (match) return;
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return match;
}

function callName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) {
    return call.expression.name.text;
  }
  return null;
}

function callsInside(
  root: ts.Node,
  name: string,
): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && callName(node) === name) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function containsCall(root: ts.Node, name: string): boolean {
  return callsInside(root, name).length !== 0;
}

function transactionBody(
  owner: NamedFunctionLike,
): ts.Block | null {
  const transactions = callsInside(owner.body!, "transaction").filter(
    (call) => {
      const callback = call.arguments[0];
      return (
        (callback !== undefined && ts.isArrowFunction(callback)) ||
        (callback !== undefined && ts.isFunctionExpression(callback))
      ) && ts.isBlock(callback.body);
    },
  );
  if (transactions.length !== 1) return null;
  const callback = transactions[0]!.arguments[0]!;
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
    return null;
  }
  return ts.isBlock(callback.body) ? callback.body : null;
}

function topLevelStatementContainingCall(
  block: ts.Block,
  name: string,
): { readonly statement: ts.Statement; readonly index: number } | null {
  const matches = block.statements
    .map((statement, index) => ({ statement, index }))
    .filter(
      ({ statement }) =>
        ts.isExpressionStatement(statement) && containsCall(statement, name),
    );
  return matches.length === 1 ? matches[0]! : null;
}

function returnsInside(root: ts.Node): ts.ReturnStatement[] {
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return returns;
}

function conditionIncludes(
  file: ts.SourceFile,
  statement: ts.Statement,
  token: string,
): statement is ts.IfStatement {
  return (
    ts.isIfStatement(statement) &&
    statement.expression.getText(file).includes(token)
  );
}

function settlementCollectionViolations(
  path: string,
  source: string,
): string[] {
  const violations: string[] = [];
  const file = sourceFile(path, source);
  const dispatcherCollections = callsInside(
    file,
    MATERIALIZATION_COLLECTION_CALL,
  );
  if (dispatcherCollections.length !== 2) {
    violations.push(
      `${path}: exact-key collection is owned only by markRetryable and markTerminal`,
    );
  }

  const retry = namedFunctionLike(file, "markRetryable");
  const retryBody = retry ? transactionBody(retry) : null;
  if (!retry || !retryBody) {
    violations.push(
      `${path}: markRetryable lost its single canonical transaction`,
    );
  } else {
    const collectionCalls = callsInside(
      retryBody,
      MATERIALIZATION_COLLECTION_CALL,
    );
    const collection = topLevelStatementContainingCall(
      retryBody,
      MATERIALIZATION_COLLECTION_CALL,
    );
    const release = topLevelStatementContainingCall(
      retryBody,
      "releaseAttempt",
    );
    const branch = retryBody.statements.find((statement) =>
      conditionIncludes(file, statement, "target_not_found_new_session")
    );
    if (
      collectionCalls.length !== 1 ||
      !collection ||
      collection.index !== retryBody.statements.length - 1
    ) {
      violations.push(
        `${path}: markRetryable must converge on one transaction-tail materialization collection`,
      );
    }
    if (
      !branch ||
      !containsCall(branch.thenStatement, "createTargetNotFoundSuccessorAttempt") ||
      !branch.elseStatement ||
      !containsCall(
        branch.elseStatement,
        "scheduleIssueExecutionAttemptRetryInTransaction",
      ) ||
      !release ||
      release.statement.getStart(file) >= branch.getStart(file) ||
      (collection !== null && branch.getStart(file) > collection.statement.getStart(file))
    ) {
      violations.push(
        `${path}: markRetryable collection does not follow both exact retry state transitions`,
      );
    }
    if (returnsInside(retryBody).length !== 0) {
      violations.push(
        `${path}: markRetryable has an early return that can bypass transaction-tail collection`,
      );
    }
  }

  const terminal = namedFunctionLike(file, "markTerminal");
  const terminalBody = terminal ? transactionBody(terminal) : null;
  if (!terminal || !terminalBody) {
    violations.push(
      `${path}: markTerminal lost its single canonical transaction`,
    );
  } else {
    const collectionCalls = callsInside(
      terminalBody,
      MATERIALIZATION_COLLECTION_CALL,
    );
    const collection = topLevelStatementContainingCall(
      terminalBody,
      MATERIALIZATION_COLLECTION_CALL,
    );
    const release = topLevelStatementContainingCall(
      terminalBody,
      "releaseAttempt",
    );
    const branch = terminalBody.statements.find((statement) =>
      conditionIncludes(file, statement, "cancellation")
    );
    const finalStatement = terminalBody.statements.at(-1);
    const returns = returnsInside(terminalBody);
    if (
      collectionCalls.length !== 1 ||
      !collection ||
      collection.index !== terminalBody.statements.length - 2 ||
      !finalStatement ||
      !ts.isReturnStatement(finalStatement) ||
      finalStatement.expression?.getText(file) !== "completed"
    ) {
      violations.push(
        `${path}: markTerminal must converge on one materialization collection immediately before its transaction result`,
      );
    }
    if (
      !branch ||
      !branch.elseStatement ||
      !branch.thenStatement.getText(file).includes("completed") ||
      !containsCall(branch.elseStatement, "completeTerminalPromptInTransaction") ||
      !release ||
      release.statement.getStart(file) >= branch.getStart(file) ||
      (collection !== null && branch.getStart(file) > collection.statement.getStart(file))
    ) {
      violations.push(
        `${path}: markTerminal collection does not follow both cancellation and completion state transitions`,
      );
    }
    if (
      returns.length !== 1 ||
      returns[0] !== finalStatement
    ) {
      violations.push(
        `${path}: markTerminal has an early return that can bypass transaction-tail collection`,
      );
    }
  }

  return violations;
}

function orderedReferenceFenceViolations(
  path: string,
  source: string,
  functionName: string,
  referenceWriterToken: string,
  label: string,
): string[] {
  const file = sourceFile(path, source);
  const owner = namedFunctionLike(file, functionName);
  if (!owner?.body) {
    return [`${path}: ${label} owner ${functionName} is missing`];
  }
  const fences = callsInside(owner.body, MATERIALIZATION_FENCE_CALL);
  const writerAt = owner.body.getText(file).indexOf(referenceWriterToken);
  if (
    fences.length !== 1 ||
    writerAt < 0 ||
    fences[0]!.getStart(file) - owner.body.getStart(file) >= writerAt
  ) {
    return [
      `${path}: ${label} is not fenced before publishing its exact materialization reference`,
    ];
  }
  return [];
}

/** Protects the sole immutable revision/physical-target skills-home channel. */
export function skillChannelBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations = [
    ...requireFileTokens(
      repositoryRoot,
      MATERIALIZER,
      MATERIALIZER_REQUIRED,
    ),
    ...requireFileTokens(repositoryRoot, TARGET_DRIVER, TARGET_REQUIRED),
    ...requireFileTokens(repositoryRoot, PROMPT_CYCLE, PROMPT_REQUIRED),
    ...requireFileTokens(
      repositoryRoot,
      MATERIALIZATION_LIFECYCLE,
      LIFECYCLE_REQUIRED,
    ),
    ...requireFileTokens(repositoryRoot, RUN_SERVICE, RUN_SERVICE_REQUIRED),
    ...requireFileTokens(repositoryRoot, DISPATCHER, DISPATCHER_REQUIRED),
    ...requireFileTokens(repositoryRoot, RETRY_SCHEDULE, RETRY_REQUIRED),
    ...requireFileTokens(repositoryRoot, REVISION_OWNER, REVISION_REQUIRED),
    ...retiredIdentifierViolations(repositoryRoot),
  ];

  const materializer = read(repositoryRoot, MATERIALIZER);
  if (materializer !== null) {
    if (/\.agents[\\/]skills/.test(materializer)) {
      violations.push(
        `${MATERIALIZER}: target store writes beneath runtime .agents/skills`,
      );
    }
    if (/\b(?:runId|attemptId|executionRefId|workspaceExposure|localWorkspaceCwd)\b/.test(materializer)) {
      violations.push(
        `${MATERIALIZER}: materialization is scoped by a run, attempt, execution ref, or workspace`,
      );
    }
    if (materializer.includes("--paperclip-")) {
      violations.push(
        `${MATERIALIZER}: provider-visible runtime name has a Paperclip execution suffix`,
      );
    }
    if (materializer.includes("result.stderr")) {
      violations.push(
        `${MATERIALIZER}: raw target diagnostics can expose selected-skill paths or digests`,
      );
    }
    if (/target\.kind\s*!==?\s*["']local["']/.test(materializer)) {
      violations.push(
        `${MATERIALIZER}: remote targets are rejected by a local-only materializer`,
      );
    }
  }

  const targetDriver = read(repositoryRoot, TARGET_DRIVER);
  if (targetDriver !== null) {
    const guard = targetDriver.indexOf(
      'input.companySkills.channel === "isolated_skills_home"',
    );
    const materialize = targetDriver.indexOf(
      "prepareSelectedCompanySkillTargetHome({",
    );
    const binder = targetDriver.indexOf("resolveTargetReadOnlyBinder({");
    if (
      guard < 0 ||
      materialize < guard ||
      binder < guard ||
      targetDriver.indexOf(
        "prepareSelectedCompanySkillTargetHome({",
        materialize + 1,
      ) >= 0
    ) {
      violations.push(
        `${TARGET_DRIVER}: skill I/O is not confined to isolated_skills_home`,
      );
    }
    if (
      /["']--bind["'][\s\S]{0,160}home\.skillsDir/.test(targetDriver) ||
      !/["']--ro-bind["'][\s\S]{0,160}home\.skillsDir/.test(targetDriver)
    ) {
      violations.push(
        `${TARGET_DRIVER}: provider discovery uses a writable selected-skill bind`,
      );
    }
  }

  const lifecycle = read(repositoryRoot, MATERIALIZATION_LIFECYCLE);
  const runService = read(repositoryRoot, RUN_SERVICE);
  const dispatcher = read(repositoryRoot, DISPATCHER);
  const promptCycle = read(repositoryRoot, PROMPT_CYCLE);
  const retrySchedule = read(repositoryRoot, RETRY_SCHEDULE);
  if (lifecycle !== null) {
    const operatorGuard = lifecycle.indexOf(
      'acpConfiguration.skillChannel === "operator_native"',
    );
    const pinRead = lifecycle.indexOf(
      "acpConfiguration.companySkillPins",
    );
    if (operatorGuard < 0 || pinRead < operatorGuard) {
      violations.push(
        `${MATERIALIZATION_LIFECYCLE}: operator_native does not return before selected-skill storage reads`,
      );
    }
    if (
      /\b(?:maxAge|olderThan|retentionMs|cutoffAt|ageThreshold)\b/.test(
        lifecycle,
      ) ||
      /issueExecution(?:Attempts|Sessions)\.createdAt\s*[<>]/.test(lifecycle)
    ) {
      violations.push(
        `${MATERIALIZATION_LIFECYCLE}: materialization GC uses age instead of exact reference fencing`,
      );
    }
    if (/\b(?:listMaterializations|collectUnreferencedMaterializations|collectAllMaterializations)\b/.test(lifecycle)) {
      violations.push(
        `${MATERIALIZATION_LIFECYCLE}: materialization GC uses a complement-list owner`,
      );
    }
  }
  if (runService !== null) {
    const referenceQueryStart = runService.indexOf(
      "hasActiveIssueExecutionAttemptForMaterializationInTransaction(",
    );
    const referenceQuery = referenceQueryStart < 0
      ? ""
      : runService.slice(referenceQueryStart, referenceQueryStart + 3_000);
    if (
      /\b(?:maxAge|olderThan|retentionMs|cutoffAt|ageThreshold)\b/.test(
        referenceQuery,
      )
    ) {
      violations.push(
        `${RUN_SERVICE}: materialization reference query uses age instead of exact active-attempt state`,
      );
    }
  }

  if (dispatcher !== null) {
    violations.push(
      ...settlementCollectionViolations(DISPATCHER, dispatcher),
      ...orderedReferenceFenceViolations(
        DISPATCHER,
        dispatcher,
        "createRunningLease",
        ".insert(issueExecutionAttempts)",
        "initial attempt materialization fence",
      ),
      ...orderedReferenceFenceViolations(
        DISPATCHER,
        dispatcher,
        "createTargetNotFoundSuccessorAttempt",
        ".insert(issueExecutionAttempts)",
        "target-not-found successor materialization fence",
      ),
    );
  }
  if (promptCycle !== null) {
    violations.push(
      ...orderedReferenceFenceViolations(
        PROMPT_CYCLE,
        promptCycle,
        "activatePrompt",
        ".insert(issueExecutionSessions)",
        "native-correlation activation materialization fence",
      ),
    );
  }
  if (retrySchedule !== null) {
    violations.push(
      ...orderedReferenceFenceViolations(
        RETRY_SCHEDULE,
        retrySchedule,
        "claimIssueExecutionAttemptRetryInTransaction",
        ".insert(issueExecutionAttempts)",
        "scheduled-retry successor materialization fence",
      ),
    );
  }

  for (const [path, forbidden] of [
    [COMPANY_SKILL_OWNER, ["__runtime__", "__versions__"]],
    [PROMPT_CYCLE, ["IssueExecutionSelectedCompanySkill", "selectedCompanySkills"]],
    [SERVER_UTILS, ["CompanySkillRuntimeEntry", "CompanySkillSelectionEntry"]],
    [ATTEMPT_EXECUTOR, ["selectedCompanySkillExposure"]],
  ] as const) {
    const source = read(repositoryRoot, path);
    if (source === null) continue;
    for (const token of forbidden) {
      if (source.includes(token)) {
        violations.push(`${path}: parallel or writable skill-channel surface ${token}`);
      }
    }
  }

  for (const absolutePath of listRepositoryTextFiles(repositoryRoot, [
    "packages/adapter-utils/src",
    "apps/server/src",
  ])) {
    const path = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
    if (!isProductionSource(path)) continue;
    const source = readFileSync(absolutePath, "utf8");
    if (
      /\b(?:writeFile|mkdir|copyFile|rename|symlink|link|rm)\s*\([\s\S]{0,320}\.agents[\\/]skills/.test(
        source,
      )
    ) {
      violations.push(`${path}: writes into runtime .agents/skills`);
    }
  }

  return [...new Set(violations)].sort();
}

export function assertSkillChannelBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "Skill-channel boundary check",
    skillChannelBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertSkillChannelBoundary(resolve(import.meta.dirname, ".."));
    console.log("Skill-channel boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
