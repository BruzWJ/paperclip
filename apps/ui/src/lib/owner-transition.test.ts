import { describe, expect, it } from "vitest";
import { buildAgentMentionHref } from "@paperclipai/shared";
import {
  bodyHasAgentMention,
  classifyOwnerTransition,
  computeComposerOwnerPreview,
  computePauseAffectsSummary,
  describeOwnerChangeInterrupt,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  isOperatorInterruptedRun,
  resolveRunStatusPresentation,
} from "./owner-transition";

const QA_ID = "agent-qa-1111";
const QA_MENTION = `[@QA](${buildAgentMentionHref(QA_ID, null)})`;

describe("owner transition helpers", () => {
  it("distinguishes operator interruption from an ordinary cancellation", () => {
    expect(isOperatorInterruptedRun("operator_interrupted")).toBe(true);
    expect(isOperatorInterruptedRun("cancelled")).toBe(false);
    expect(resolveRunStatusPresentation("cancelled", { operatorInterrupted: true }).label).toBe("interrupted");
    expect(resolveRunStatusPresentation("cancelled").label).toBe("cancelled");
  });

  it("recognizes only structured agent mentions as notifications", () => {
    expect(extractAgentMentionIds(`please ask ${QA_MENTION}`)).toEqual([QA_ID]);
    expect(bodyHasAgentMention(QA_MENTION)).toBe(true);
    expect(bodyHasAgentMention("please ask QA")).toBe(false);
    expect(findPlainAgentNameCandidate("please ask QA", [{ agentId: QA_ID, name: "QA" }]))
      .toEqual({ agentId: QA_ID, matchedText: "QA" });
  });

  it("previews only canonical agent-owner changes", () => {
    expect(computeComposerOwnerPreview({
      ownerTarget: `agent:${QA_ID}`,
      currentOwnerValue: "agent:agent-coder",
      hasActiveRun: true,
      bodyHasAgentMention: false,
    })).toMatchObject({
      kind: "interrupt_change_owner",
      chip: { kind: "agent", id: QA_ID },
    });
    expect(computeComposerOwnerPreview({
      ownerTarget: "agent:agent-coder",
      currentOwnerValue: "agent:agent-coder",
      hasActiveRun: false,
      bodyHasAgentMention: false,
      plainNameCandidate: { agentId: QA_ID, matchedText: "QA" },
    })).toMatchObject({ kind: "plain_text_only", tone: "warn" });
  });

  it("describes agent, exceptional user, and board owner transitions", () => {
    expect(classifyOwnerTransition({
      ownerKind: "agent",
      ownerAgentId: QA_ID,
      ownerUserId: null,
    }, { agentName: "QA" })).toMatchObject({
      kind: "agent_dispatch",
      dispatchText: "queued for QA",
    });
    expect(classifyOwnerTransition({
      ownerKind: "user",
      ownerAgentId: null,
      ownerUserId: "user-board",
    }).kind).toBe("user_owner");
    expect(classifyOwnerTransition({
      ownerKind: "board",
      ownerAgentId: null,
      ownerUserId: null,
    }).kind).toBe("board_owner");
  });

  it("summarizes live, queued, and inactive pause effects", () => {
    const summary = computePauseAffectsSummary([
      { activeRun: { status: "running" } },
      { activeRun: { status: "queued" } },
      { activeRun: null },
      { activeRun: null, skipped: true },
    ]);
    expect(summary.affectedIssueCount).toBe(3);
    expect(summary.buckets.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: "live_runs", count: 1 },
      { key: "queued_runs", count: 1 },
      { key: "inactive", count: 1 },
    ]);
  });

  it("uses owner language for the live-run confirmation", () => {
    expect(describeOwnerChangeInterrupt({ runningAgentName: "ClaudeCoder" })).toMatchObject({
      banner: "ClaudeCoder is running — changing the owner will interrupt this run.",
      confirmAction: "Interrupt & change owner",
    });
  });
});
