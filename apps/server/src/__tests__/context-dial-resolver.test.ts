import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_GRANT_KEYS } from "@paperclipai/shared";
import {
  contextDialDigest,
  resolveContextDial,
  resolveContextRetrievalPolicy,
} from "../services/context-dial-resolver.ts";

describe("context dial resolver", () => {
  it("treats missing agent grants as false", () => {
    const result = resolveContextDial({
      agent: {
        carry_context: true,
        read_task_comments: true,
      },
    });

    expect(result.effective.carry_context).toBe(true);
    expect(result.effective.read_task_comments).toBe(true);
    for (const key of AGENT_CONTEXT_GRANT_KEYS) {
      if (key === "carry_context" || key === "read_task_comments") continue;
      expect(result.effective[key]).toBe(false);
    }
  });

  it("gives an active task owner only the current and sub-task baseline", () => {
    const result = resolveContextDial({
      agent: {},
      taskOwner: true,
    });

    expect(result.effective).toEqual({
      carry_context: true,
      read_task_comments: true,
      read_task_agent_run: true,
      list_sub_tasks: true,
      read_sub_task_comments: true,
      read_sub_task_agent_run: true,
      list_company_tasks: false,
      read_company_task_comments: false,
      read_company_task_agent_run: false,
    });
  });

  it("keeps company cells at the agent's configured grants", () => {
    const result = resolveContextDial({
      agent: {
        list_company_tasks: true,
        read_company_task_agent_run: true,
      },
      taskOwner: true,
    });

    expect(result.effective).toEqual({
      carry_context: true,
      read_task_comments: true,
      read_task_agent_run: true,
      list_sub_tasks: true,
      read_sub_task_comments: true,
      read_sub_task_agent_run: true,
      list_company_tasks: true,
      read_company_task_comments: false,
      read_company_task_agent_run: true,
    });
  });

  it("does not grant the owner baseline to another execution mode", () => {
    const result = resolveContextDial({
      agent: {},
      taskOwner: false,
    });

    expect(Object.values(result.effective).every((enabled) => !enabled)).toBe(true);
  });

  it("allows execution mode only to attenuate the owner baseline", () => {
    const result = resolveContextDial({
      agent: {},
      taskOwner: true,
      executionMode: { read_task_comments: false },
    });

    expect(result.effective.read_task_comments).toBe(false);
    expect(result.effective.read_sub_task_comments).toBe(true);
  });

  it("uses the exact retrieval-tool union rules", () => {
    const policy = resolveContextRetrievalPolicy(
      resolveContextDial({
        agent: {
          list_company_tasks: true,
          read_sub_task_comments: true,
          read_company_task_agent_run: true,
        },
      }).effective,
    );

    expect(policy).toEqual({
      listCompanyTasks: true,
      listSubTasks: {
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
        taskIdRequired: true,
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
          agent: { read_task_comments: true },
        }).effective,
      ),
    );
  });
});
