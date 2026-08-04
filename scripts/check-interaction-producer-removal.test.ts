// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: buildExecutionStageWakeup, queueResolvedInteractionContinuationWakeup, acceptedInteractionId, accepted_interaction_id
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { interactionProducerRemovalViolations } from "./check-interaction-producer-removal.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function canonicalGatewaySource(): string {
  return [
    "async function executeApprovedAgentInvocation() {",
    '  eq(toolActionRequests.status, "approved");',
    "  dispatchIdempotencyKey;",
    "  resolveInvocationToolBinding();",
    "  approvalSnapshotsMatch();",
    "  const parameters = claimed.canonicalArguments;",
    "}",
    "",
  ].join("\n");
}

function canonicalPipelineSource(): string {
  return [
    "router.post(",
    '    "/cases/:caseId/open-conversation",',
    "    async (req) => {",
    "      assertBoard(req);",
    "      const userId = req.actor.userId.trim();",
    "      ordinaryIssues.create({",
    "        request: req.body.request,",
    "        ownerAgentId: req.body.ownerAgentId,",
    '        creator: { kind: "user/board", userId },',
    "      });",
    "    },",
    "  );",
    "",
  ].join("\n");
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-producer-gate-"));
  roots.add(root);
  write(root, "apps/server/src/services/tool-gateway.ts", canonicalGatewaySource());
  write(root, "apps/server/src/routes/pipelines.ts", canonicalPipelineSource());
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts canonical board claim-and-execute and Pipeline issue ingress", () => {
  assert.deepEqual(interactionProducerRemovalViolations(fixtureRoot()), []);
});

for (const token of [
  "approvalRequiredInstructions",
  "approvedActionRequestId",
  "buildExecutionStageWakeup",
  "queueResolvedInteractionContinuationWakeup",
  "acceptedInteractionId",
  "accepted_interaction_id",
  "buildCaseContextMarkdown",
] as const) {
  test(`rejects retired interaction producer ${token}`, () => {
    const root = fixtureRoot();
    write(root, "apps/server/src/services/retired-producer.ts", `export const retired = ${JSON.stringify(token)};\n`);
    assert.ok(
      interactionProducerRemovalViolations(root).some((violation) =>
        violation.includes(token),
      ),
    );
  });
}

test("rejects approval execution when the canonical claim/check order changes", () => {
  const root = fixtureRoot();
  write(
    root,
    "apps/server/src/services/tool-gateway.ts",
    [
      "async function executeApprovedAgentInvocation() {",
      "  resolveInvocationToolBinding();",
      '  eq(toolActionRequests.status, "approved");',
      "  dispatchIdempotencyKey;",
      "  approvalSnapshotsMatch();",
      "  const parameters = claimed.canonicalArguments;",
      "}",
      "",
    ].join("\n"),
  );
  assert.ok(
    interactionProducerRemovalViolations(root).some((violation) =>
      violation.includes("claim/check/execute order changed"),
    ),
  );
});

for (const token of [
  "assertBoard(req)",
  "req.actor.userId.trim()",
  "request: req.body.request",
  "ownerAgentId: req.body.ownerAgentId",
  'creator: { kind: "user/board", userId }',
] as const) {
  test(`fails closed when Pipeline ingress loses ${token}`, () => {
    const root = fixtureRoot();
    write(
      root,
      "apps/server/src/routes/pipelines.ts",
      canonicalPipelineSource().replace(token, "removedCanonicalIngress"),
    );
    assert.ok(
      interactionProducerRemovalViolations(root).some((violation) =>
        violation.includes(`missing canonical ownership token ${token}`),
      ),
    );
  });
}
