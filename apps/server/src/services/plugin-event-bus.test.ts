import { describe, expect, it, vi } from "vitest";
import { createPluginEventBus } from "./plugin-event-bus.js";

describe("plugin event bus", () => {
  it("replaces an identical subscription instead of duplicating restart delivery", async () => {
    const bus = createPluginEventBus();
    const scoped = bus.forPlugin("paperclip.example");
    const stale = vi.fn(async () => undefined);
    const current = vi.fn(async () => undefined);
    scoped.subscribe("issue.comment.created", { companyId: "company" }, stale);
    scoped.subscribe("issue.comment.created", { companyId: "company" }, current);

    expect(bus.subscriptionCount("paperclip.example")).toBe(1);
    await bus.emit({
      eventId: "event",
      eventType: "issue.comment.created",
      occurredAt: "2026-08-05T00:00:00.000Z",
      companyId: "company",
      payload: {},
    });

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });
});
