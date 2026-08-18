// @vitest-environment node

import type { ActivityLoggedLiveEventPayload } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { invalidateActivityQueries } from "../lib/live-query-invalidation";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_ID = "55555555-5555-4555-8555-555555555555";
const FINANCE_EVENT_ID = "66666666-6666-4666-8666-666666666666";
const PLUGIN_ID = "77777777-7777-4777-8777-777777777777";

function activityPayload(
  overrides: Partial<ActivityLoggedLiveEventPayload> = {},
): ActivityLoggedLiveEventPayload {
  return {
    actorType: "user",
    actorId: "user-1",
    action: "task.title_updated",
    entityType: "task",
    entityId: TASK_ID,
    agentId: null,
    runId: null,
    taskId: TASK_ID,
    responsibleUserId: "user-1",
    details: null,
    ...overrides,
  };
}

describe("LiveUpdatesProvider canonical invalidation", () => {
  it("invalidates task projections only by the event's canonical task UUID", () => {
    const invalidateQueries = vi.fn();
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    invalidateActivityQueries(
      queryClient as never,
      COMPANY_ID,
      activityPayload({
        details: { identifier: "PAP-1", taskId: "details-are-not-identity" },
      }),
      { userId: null },
      { taskId: null, foregrounded: false },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "detail", TASK_ID],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "runs", TASK_ID],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["tasks", "detail", "PAP-1"] }),
    );
    expect(invalidateQueries).not.toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["tasks", "detail", "details-are-not-identity"],
      }),
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", COMPANY_ID],
    });
  });

  it("refreshes run lists without refetching the websocket-backed open transcript", () => {
    const invalidateQueries = vi.fn();
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    invalidateActivityQueries(
      queryClient as never,
      COMPANY_ID,
      activityPayload({
        entityType: "local_run_lease",
        entityId: LEASE_ID,
        action: "execution.local_lease_released",
        runId: RUN_ID,
        taskId: TASK_ID,
        details: { taskId: "stale-details-task" },
      }),
      { userId: null },
      { taskId: null, foregrounded: false },
    );

    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["runs", "detail", RUN_ID],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["runs", COMPANY_ID],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "runs", TASK_ID],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["tasks", "runs", "stale-details-task"],
      }),
    );
  });

  it("matches the foreground route directly by canonical task UUID", () => {
    const invalidateQueries = vi.fn();
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    invalidateActivityQueries(
      queryClient as never,
      COMPANY_ID,
      activityPayload({
        action: "task.updated",
        actorType: "agent",
        actorId: AGENT_ID,
        agentId: AGENT_ID,
        details: { identifier: "PAP-1" },
      }),
      { userId: null },
      { taskId: TASK_ID, foregrounded: true },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "detail", TASK_ID],
      refetchType: "inactive",
    });
  });

  it("maps finance activity without refreshing unrelated routine data", () => {
    const invalidateQueries = vi.fn();
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    invalidateActivityQueries(
      queryClient as never,
      COMPANY_ID,
      activityPayload({
        entityType: "finance_event",
        entityId: FINANCE_EVENT_ID,
        action: "finance_event.reported",
        taskId: null,
      }),
      { userId: null },
      { taskId: null, foregrounded: false },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["finance-summary", COMPANY_ID],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["routines", COMPANY_ID, "__all-projects__"],
    });
  });

  it("refreshes agent collections and UUID-backed detail projections", () => {
    const invalidateQueries = vi.fn();
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    invalidateActivityQueries(
      queryClient as never,
      COMPANY_ID,
      activityPayload({
        entityType: "agent",
        entityId: AGENT_ID,
        action: "agent.paused",
        agentId: AGENT_ID,
        taskId: null,
      }),
      { userId: null },
      { taskId: null, foregrounded: false },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["agents", COMPANY_ID],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["agents", "detail", AGENT_ID],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["agents", AGENT_ID, "runtime-configuration", COMPANY_ID],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["runs", COMPANY_ID, AGENT_ID],
    });
  });

  it("keeps plugin-defined entity types within aggregate and plugin projections", () => {
    const invalidateQueries = vi.fn();
    const queryClient = {
      invalidateQueries,
      getQueryData: () => undefined,
    };

    invalidateActivityQueries(
      queryClient as never,
      COMPANY_ID,
      activityPayload({
        actorType: "plugin",
        actorId: PLUGIN_ID,
        entityType: "ticket",
        entityId: "ticket-1",
        action: "ticket.updated",
        taskId: null,
      }),
      { userId: null },
      { taskId: null, foregrounded: false },
    );

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["plugins"] });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["runs", COMPANY_ID],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["costs", COMPANY_ID],
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["routines", COMPANY_ID],
    });
  });
});
