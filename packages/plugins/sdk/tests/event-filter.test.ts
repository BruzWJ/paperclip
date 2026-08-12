import { describe, expect, it } from "vitest";
import {
  assertPluginEventSubscription,
  pluginEventMatchesFilter,
} from "../src/event-filter.js";
import type { PluginEvent } from "../src/types.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

function event(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: EVENT_ID,
    eventType: "task.board.comment.created",
    occurredAt: "2026-08-05T00:00:00.000Z",
    companyId: COMPANY_ID,
    payload: {},
    ...overrides,
  };
}

describe("pluginEventMatchesFilter", () => {
  it("uses the required top-level company identity", () => {
    expect(pluginEventMatchesFilter(
      event({ payload: { companyId: "different" } }),
      { companyId: COMPANY_ID },
    )).toBe(true);
  });

  it("uses the canonical terminal-run payload agent identity", () => {
    expect(pluginEventMatchesFilter(
      event({ eventType: "agent.run.finished", payload: { agentId: AGENT_ID } }),
      { agentId: AGENT_ID },
    )).toBe(true);
  });

  it("does not coerce malformed payload identity values", () => {
    expect(pluginEventMatchesFilter(
      event({ payload: { agentId: 42 } }),
      { agentId: "42" },
    )).toBe(false);
  });
});

describe("assertPluginEventSubscription", () => {
  it("rejects an agent filter on the board-comment core event", () => {
    expect(() => assertPluginEventSubscription(
      "task.board.comment.created",
      { agentId: AGENT_ID },
    )).toThrow("agentId is not supported");
  });

  it("accepts agent filters for terminal core events and plugin patterns", () => {
    expect(() => assertPluginEventSubscription(
      "agent.run.finished",
      { agentId: AGENT_ID },
    )).not.toThrow();
    expect(() => assertPluginEventSubscription(
      "plugin.source.*",
      { agentId: AGENT_ID },
    )).not.toThrow();
  });

  it("rejects unknown and inexact filter fields", () => {
    expect(() => assertPluginEventSubscription(
      "agent.run.finished",
      { projectId: "project" } as never,
    )).toThrow("Unsupported plugin event filter field: projectId");
    expect(() => assertPluginEventSubscription(
      "agent.run.finished",
      { companyId: ` ${OTHER_COMPANY_ID} ` },
    )).toThrow("companyId must be an exact canonical UUID");
  });
});
