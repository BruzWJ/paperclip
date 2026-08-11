import { describe, expect, it } from "vitest";
import {
  assertPluginEventSubscription,
  pluginEventMatchesFilter,
} from "../src/event-filter.js";
import type { PluginEvent } from "../src/types.js";

function event(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventId: "event",
    eventType: "task.board.comment.created",
    occurredAt: "2026-08-05T00:00:00.000Z",
    companyId: "company",
    payload: {},
    ...overrides,
  };
}

describe("pluginEventMatchesFilter", () => {
  it("uses the required top-level company identity", () => {
    expect(pluginEventMatchesFilter(
      event({ payload: { companyId: "different" } }),
      { companyId: "company" },
    )).toBe(true);
  });

  it("uses the canonical terminal-run payload agent identity", () => {
    expect(pluginEventMatchesFilter(
      event({ eventType: "agent.run.finished", payload: { agentId: "agent" } }),
      { agentId: "agent" },
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
      { agentId: "agent" },
    )).toThrow("agentId is not supported");
  });

  it("accepts agent filters for terminal core events and plugin patterns", () => {
    expect(() => assertPluginEventSubscription(
      "agent.run.finished",
      { agentId: "agent" },
    )).not.toThrow();
    expect(() => assertPluginEventSubscription(
      "plugin.source.*",
      { agentId: "agent" },
    )).not.toThrow();
  });

  it("rejects unknown and inexact filter fields", () => {
    expect(() => assertPluginEventSubscription(
      "agent.run.finished",
      { projectId: "project" } as never,
    )).toThrow("Unsupported plugin event filter field: projectId");
    expect(() => assertPluginEventSubscription(
      "agent.run.finished",
      { companyId: " company " },
    )).toThrow("companyId must be exact and non-empty");
  });
});
