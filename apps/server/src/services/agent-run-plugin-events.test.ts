import { describe, expect, it, vi } from "vitest";
import { publishAgentRunTerminalEvent } from "./agent-run-plugin-events.js";

describe("agent run plugin events", () => {
  it.each([
    ["succeeded", "agent.run.finished"],
    ["failed", "agent.run.failed"],
    ["cancelled", "agent.run.cancelled"],
  ] as const)("publishes %s only through the awaited app seam", async (outcome, eventType) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = vi.fn(async () => blocked);

    let settled = false;
    const publishing = publishAgentRunTerminalEvent(
      { publish },
      {
        companyId: "company-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        outcome,
        reason: null,
        occurredAt: new Date("2026-08-06T00:00:00.000Z"),
      },
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventType,
      occurredAt: "2026-08-06T00:00:00.000Z",
      companyId: "company-1",
      entityId: "run-1",
      payload: {
        companyId: "company-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        outcome,
        reason: null,
      },
    }));

    release();
    await publishing;
    expect(settled).toBe(true);
  });
});
