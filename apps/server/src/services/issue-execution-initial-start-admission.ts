import {
  agentContextGrants,
  agents,
  issueExecutionSessions,
  issueExecutionWorkspaceBindings,
  issues,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { contextDialDigest } from "./context-dial-resolver.js";
import type {
  DispatchingExecutionSourceInput,
  IssueSessionAdmissionResult,
  IssueSessionAdmissionService,
} from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { localExecutionCorrelationFingerprint } from "./local-execution-correlation.js";
import { resolveRuntimeContextDial } from "./runtime-interface-compiler-db.js";

const ROLE_BOOTSTRAP_SUFFIX =
  "\n\nThis is your role bootstrap turn, not issue work. Do not inspect the filesystem, workspace, repository, home directory, environment, global configuration, or provider configuration, and do not use provider-local tools. If you need organizational or company context, use only the Paperclip-managed tools available in this turn. Briefly acknowledge the role and end the turn; the issue request will arrive as a separate queued turn.";

/** @internal Preserves the board-owned instruction bytes before the fixed suffix. */
export function renderAgentInstructionBootstrap(
  instruction: string | null | undefined,
): string | null {
  return instruction && instruction.trim().length > 0
    ? `${instruction}${ROLE_BOOTSTRAP_SUFFIX}`
    : null;
}

/**
 * Sole target admission path. Exact carry resumes with one work ref; a target
 * without carry receives one atomic instruction/work pair, or the explicitly
 * authorized work singleton when its instruction is blank.
 */
export async function admitIssueExecutionInTransaction(input: {
  readonly sessionAdmission: IssueSessionAdmissionService;
  readonly transaction: IssueSessionDbTransaction;
  readonly work: DispatchingExecutionSourceInput;
}): Promise<IssueSessionAdmissionResult> {
  const work = input.work;
  const [agentRows, issueRows, bindingRows, contextRows] = await Promise.all([
    input.transaction.select({ instruction: agents.instruction }).from(agents)
      .where(and(eq(agents.companyId, work.companyId), eq(agents.id, work.targetAgentId)))
      .limit(2).for("share"),
    input.transaction.select({
      companyId: issues.companyId, ownerKind: issues.ownerKind,
      ownerAgentId: issues.ownerAgentId, ownershipEpoch: issues.ownershipEpoch,
      workMode: issues.workMode, harnessKind: issues.harnessKind,
      originKind: issues.originKind, executionPolicy: issues.executionPolicy,
    }).from(issues).where(and(
      eq(issues.companyId, work.companyId), eq(issues.id, work.issueId),
      eq(issues.ownershipEpoch, work.ownershipEpoch),
    )).limit(2).for("share"),
    input.transaction.select({ id: issueExecutionWorkspaceBindings.id })
      .from(issueExecutionWorkspaceBindings).where(and(
        eq(issueExecutionWorkspaceBindings.companyId, work.companyId),
        eq(issueExecutionWorkspaceBindings.issueId, work.issueId),
        eq(issueExecutionWorkspaceBindings.sessionId, work.sessionId),
        eq(issueExecutionWorkspaceBindings.ownershipEpoch, work.ownershipEpoch),
      )).limit(2).for("share"),
    input.transaction.select({ key: agentContextGrants.key })
      .from(agentContextGrants).where(and(
        eq(agentContextGrants.companyId, work.companyId),
        eq(agentContextGrants.agentId, work.targetAgentId),
      )).for("share"),
  ]);
  if (agentRows.length !== 1 || issueRows.length !== 1 || bindingRows.length !== 1) {
    throw new Error("Issue execution target lost its canonical admission scope");
  }
  const contextDial = resolveRuntimeContextDial({
    capability: { targetAgentId: work.targetAgentId, executionMode: work.mode },
    issue: issueRows[0]!,
    contextGrantKeys: contextRows.map((row) => row.key),
  });
  const carry = contextDial.carry_context
    ? await input.transaction.select({ id: issueExecutionSessions.id })
      .from(issueExecutionSessions).where(and(
        eq(issueExecutionSessions.companyId, work.companyId),
        eq(issueExecutionSessions.issueId, work.issueId),
        eq(issueExecutionSessions.ownershipEpoch, work.ownershipEpoch),
        eq(issueExecutionSessions.targetAgentId, work.targetAgentId),
        eq(issueExecutionSessions.adapterConfigIdentity, work.adapterConfigRevisionId),
        eq(issueExecutionSessions.workspaceIdentity, bindingRows[0]!.id),
        eq(issueExecutionSessions.targetFingerprint,
          localExecutionCorrelationFingerprint(work.adapterConfigRevisionId)),
        eq(issueExecutionSessions.purpose, "carry"),
        eq(issueExecutionSessions.state, "eligible"),
        eq(issueExecutionSessions.laneKind, work.mode),
        eq(issueExecutionSessions.authorizedContextExposureDigest,
          contextDialDigest(contextDial)),
      )).limit(2).for("update")
    : [];
  if (carry.length > 1) throw new Error("Issue execution target carry is ambiguous");
  const bootstrapText = carry.length === 0
    ? renderAgentInstructionBootstrap(agentRows[0]!.instruction)
    : null;
  if (carry.length === 1 || bootstrapText === null) {
    return input.sessionAdmission.admitExecutionSource(work, input.transaction);
  }

  const { previousOwnershipEpoch: _previousOwnershipEpoch, ...bootstrapScope } = work;
  const bootstrapKey = `${work.immutableSourceKey}:bootstrap`;
  const admitted = await input.sessionAdmission.admitExecutionSourceBatch({
    batchKey: work.immutableSourceKey,
    sources: [{
      ...bootstrapScope,
      sourceKind: "issue_request",
      actor: { kind: "system", sourceKind: "issue_request", sourceId: work.issueId },
      immutableSourceKey: bootstrapKey,
      exactText: bootstrapText,
      comment: null,
      idempotencyKey: bootstrapKey,
    }, work],
  }, input.transaction);
  if (!admitted[1]) throw new Error("Issue execution pair lost its work member");
  return admitted[1];
}
