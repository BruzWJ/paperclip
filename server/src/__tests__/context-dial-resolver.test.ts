import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
import {
  allContextCellsFalse,
  contextDialDigest,
  resolveContextDial,
  resolveContextRetrievalPolicy,
  resolveFreshCompositionDepth,
  stampAttentionPreset,
} from "../services/context-dial-resolver.ts";

describe("context dial resolver", () => {
  it("treats missing agent grants as false and missing masks as identity", () => {
    const result = resolveContextDial({
      agent: {
        carry_context: true,
        read_issue_comments: true,
      },
    });

    expect(result.effective.carry_context).toBe(true);
    expect(result.effective.read_issue_comments).toBe(true);
    for (const key of AGENT_CONTEXT_GRANT_KEYS) {
      if (key === "carry_context" || key === "read_issue_comments") continue;
      expect(result.effective[key]).toBe(false);
    }
  });

  it("allows assignment and execution mode only to attenuate", () => {
    const result = resolveContextDial({
      agent: {
        carry_context: true,
        read_issue_comments: true,
        read_issue_agent_run: false,
      },
      assignment: {
        carry_context: false,
        read_issue_agent_run: true,
      },
      executionMode: {
        read_issue_comments: false,
        read_issue_agent_run: true,
      },
    });

    expect(result.effective.carry_context).toBe(false);
    expect(result.effective.read_issue_comments).toBe(false);
    expect(result.effective.read_issue_agent_run).toBe(false);
    expect(allContextCellsFalse(result.effective)).toBe(true);
  });

  it("stamps the exact five presets without persisting preset authority", () => {
    expect(stampAttentionPreset("heads_down")).toEqual(
      Object.fromEntries(AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false])),
    );
    expect(stampAttentionPreset("focused")).toMatchObject({
      carry_context: true,
      read_issue_comments: true,
      list_sub_issues: false,
    });
    expect(stampAttentionPreset("supervisor")).toMatchObject({
      carry_context: true,
      read_issue_comments: true,
      list_sub_issues: true,
      read_sub_issue_comments: true,
      read_issue_agent_run: false,
    });
    expect(stampAttentionPreset("investigator")).toMatchObject({
      read_issue_agent_run: true,
      read_sub_issue_agent_run: false,
      list_company_issues: false,
    });
    expect(stampAttentionPreset("situational")).toMatchObject({
      read_issue_agent_run: true,
      read_sub_issue_agent_run: false,
      list_company_issues: true,
      read_company_issue_comments: false,
      read_company_issue_agent_run: false,
    });
  });

  it("derives fresh composition depth from only active-issue content cells", () => {
    expect(
      resolveFreshCompositionDepth(
        resolveContextDial({
          agent: { read_company_issue_agent_run: true },
        }).effective,
      ),
    ).toBeNull();
    expect(
      resolveFreshCompositionDepth(
        resolveContextDial({
          agent: { read_issue_comments: true },
        }).effective,
      ),
    ).toBe("thread");
    expect(
      resolveFreshCompositionDepth(
        resolveContextDial({
          agent: {
            read_issue_comments: true,
            read_issue_agent_run: true,
          },
        }).effective,
      ),
    ).toBe("turns");
  });

  it("uses the exact retrieval-tool union rules", () => {
    const policy = resolveContextRetrievalPolicy(
      resolveContextDial({
        agent: {
          list_company_issues: true,
          read_sub_issue_comments: true,
          read_company_issue_agent_run: true,
        },
      }).effective,
    );

    expect(policy).toEqual({
      listCompanyIssues: true,
      listSubIssues: {
        enabled: true,
        omittedActive: true,
        explicit: {
          active: true,
          descendant: false,
          company: true,
        },
      },
      comments: {
        active: false,
        descendant: true,
        company: false,
        enabled: true,
        issueIdRequired: true,
      },
      runs: {
        active: false,
        descendant: false,
        company: true,
        enabled: true,
      },
    });
  });

  it("produces a stable order-sensitive canonical digest", () => {
    const dial = resolveContextDial({
      agent: { carry_context: true },
    }).effective;
    expect(contextDialDigest(dial)).toBe(contextDialDigest({ ...dial }));
    expect(contextDialDigest(dial)).not.toBe(
      contextDialDigest(
        resolveContextDial({
          agent: { read_issue_comments: true },
        }).effective,
      ),
    );
  });
});
