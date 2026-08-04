import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  literalRemovalViolations,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const IGNORED_PATHS = [
  "scripts/check-run-progress-comment-contract.ts",
  "scripts/check-run-progress-comment-contract.test.ts",
] as const;

const REQUIRED_OWNERS = [
  {
    path: "packages/shared/src/constants.ts",
    tokens: ["ISSUE_COMMENT_PRESENTATION_KINDS", '"run_progress"'],
  },
  {
    path: "packages/shared/src/types/issue.ts",
    tokens: ["IssueCommentCanonicalSourceKind", '| "run_progress"'],
  },
  {
    path: "packages/db/schema/issue_comments.ts",
    tokens: ["issue_comments_canonical_source_kind_check", "'run_progress'"],
  },
  {
    path: "packages/db/schema/issue_comment_projection_sources.ts",
    tokens: [
      "issue_comment_projection_sources_run_progress_uq",
      "issue_comment_projection_sources_run_check",
      "'run_progress'",
    ],
  },
  {
    path: "apps/server/src/services/issue-execution-dispatcher-postgres.ts",
    tokens: [
      'immutableSourceKey: `run-progress:${created.run.runId}`',
      "sourceRecordId: created.run.runId",
      'exactText: ""',
      'projectionKind: "run_progress"',
      "runId: created.run.runId",
    ],
  },
  {
    path: "apps/server/src/services/issue-session/admission.ts",
    tokens: [
      'input.sourceKind === "run_progress"',
      'kind: "run_progress" as const',
    ],
  },
  {
    path: "apps/server/src/services/issue-session/projector.ts",
    tokens: [
      "projectIssueSessionFinalCommentInTx",
      'eq(issueCommentProjectionSources.sourceKind, "run_progress")',
      "eq(issueCommentProjectionSources.commentId, input.progressCommentId)",
      'comment.body !== ""',
      'comment.presentation?.kind !== "run_progress"',
      "eq(issueComments.id, comment.id)",
    ],
  },
  {
    path: "apps/server/src/services/issue-execution-finalization-postgres.ts",
    tokens: [
      "progressCommentId: progress.comment.id",
      "folded.id !== progress.comment.id",
      "Stable progress comment did not fold to the exact terminal assistant",
    ],
  },
  {
    path: "apps/server/src/services/context-retrieval.ts",
    tokens: [
      "function providerSafeCommentBody(value: unknown): string",
      "body: providerSafeCommentBody(comment.body)",
    ],
  },
  {
    path: "apps/server/src/routes/openapi.ts",
    tokens: ["boardIssueCommentSchema", "boardIssueCommentGroupPageSchema"],
  },
  {
    path: "apps/ui/src/api/issues.ts",
    tokens: ["IssueComment", "BoardIssueComment"],
  },
  {
    path: "apps/ui/src/lib/issue-chat-messages.ts",
    tokens: [
      'comment.presentation?.kind === "run_progress"',
      'comment.runState === "queued"',
      '"Queued…"',
      'comment.runState === "working"',
      '"Working…"',
      "id: comment.id",
    ],
  },
] as const;

export function runProgressCommentContractViolations(
  repositoryRoot: string,
): string[] {
  const violations = literalRemovalViolations(repositoryRoot, {
    forbiddenTokens: ["run-assistant:"],
    ignoredPaths: IGNORED_PATHS,
  });

  for (const owner of REQUIRED_OWNERS) {
    violations.push(
      ...requireFileTokens(repositoryRoot, owner.path, owner.tokens),
    );
  }

  const uiPath = resolve(repositoryRoot, "apps/ui/src/lib/issue-chat-messages.ts");
  if (existsSync(uiPath)) {
    const source = readFileSync(uiPath, "utf8");
    for (const label of ['"Queued..."', '"Working..."']) {
      if (source.includes(label)) {
        violations.push(
          `apps/ui/src/lib/issue-chat-messages.ts: run progress label must use U+2026, not ${label}`,
        );
      }
    }
  }

  const dispatcherPath = resolve(
    repositoryRoot,
    "apps/server/src/services/issue-execution-dispatcher-postgres.ts",
  );
  if (existsSync(dispatcherPath)) {
    const source = readFileSync(dispatcherPath, "utf8");
    for (const storedLabel of [
      'exactText: "Queued…"',
      'exactText: "Working…"',
      'exactText: "Queued..."',
      'exactText: "Working..."',
    ]) {
      if (source.includes(storedLabel)) {
        violations.push(
          `apps/server/src/services/issue-execution-dispatcher-postgres.ts: run progress label must be UI-derived, not stored as ${storedLabel}`,
        );
      }
    }
  }

  const retrievalPath = resolve(
    repositoryRoot,
    "apps/server/src/services/context-retrieval.ts",
  );
  if (existsSync(retrievalPath)) {
    const source = readFileSync(retrievalPath, "utf8");
    if (/requiredString\s*\(\s*comment\.body\b/.test(source)) {
      violations.push(
        "apps/server/src/services/context-retrieval.ts: run-progress comment bodies must accept the canonical empty string",
      );
    }
  }

  return [...new Set(violations)].sort();
}

export function assertRunProgressCommentContract(
  repositoryRoot: string,
): void {
  assertNoGateViolations(
    "Run-progress comment contract check",
    runProgressCommentContractViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertRunProgressCommentContract(resolve(import.meta.dirname, ".."));
    console.log("Run-progress comment contract check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
