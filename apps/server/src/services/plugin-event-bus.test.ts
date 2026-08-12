import { describe, expect, it, vi } from "vitest";
import { createPluginEventBus } from "./plugin-event-bus.js";

const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("plugin event bus", () => {
  it("replaces an identical subscription instead of duplicating restart delivery", async () => {
    const bus = createPluginEventBus();
    const scoped = bus.forPlugin("paperclip.example");
    const stale = vi.fn(async () => undefined);
    const current = vi.fn(async () => undefined);
    scoped.subscribe("task.board.comment.created", { companyId: COMPANY_ID }, stale);
    scoped.subscribe("task.board.comment.created", { companyId: COMPANY_ID }, current);

    expect(bus.subscriptionCount("paperclip.example")).toBe(1);
    await bus.emit({
      eventId: EVENT_ID,
      eventType: "task.board.comment.created",
      occurredAt: "2026-08-05T00:00:00.000Z",
      companyId: COMPANY_ID,
      payload: {},
    });

    expect(stale).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledOnce();
  });

  it("delivers once when one handler matches overlapping subscriptions", async () => {
    const bus = createPluginEventBus();
    const scoped = bus.forPlugin("paperclip.example");
    const handler = vi.fn(async () => undefined);
    scoped.subscribe("plugin.source.synced", handler);
    scoped.subscribe("plugin.source.*", handler);

    await bus.emit({
      eventId: EVENT_ID,
      eventType: "plugin.source.synced",
      occurredAt: "2026-08-05T00:00:00.000Z",
      companyId: COMPANY_ID,
      payload: {},
    });

    expect(bus.subscriptionCount("paperclip.example")).toBe(2);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects undeclared core patterns and non-terminal wildcards", () => {
    const scoped = createPluginEventBus().forPlugin("paperclip.example");
    const subscribe = scoped.subscribe as unknown as (
      pattern: string,
      handler: () => Promise<void>,
    ) => void;
    const handler = async () => undefined;

    expect(() => subscribe("task.*", handler)).toThrow("Unsupported plugin event subscription pattern");
    expect(() => subscribe("plugin.source.*.done", handler)).toThrow(
      'wildcards are supported only as a trailing ".*"',
    );
  });

  it("rejects an agent filter for the board-comment core event", () => {
    const scoped = createPluginEventBus().forPlugin("paperclip.example");
    expect(() => scoped.subscribe(
      "task.board.comment.created",
      { agentId: AGENT_ID },
      async () => undefined,
    )).toThrow("agentId is not supported");
  });

  it("rejects identity aliases instead of rewriting plugin events", async () => {
    const bus = createPluginEventBus();
    expect(() => bus.forPlugin(" paperclip.example ")).toThrow(
      "Plugin identity must be an exact non-empty string",
    );
    const scoped = bus.forPlugin("paperclip.example");

    await expect(scoped.emit(" sync-done ", COMPANY_ID, {})).rejects.toThrow(
      "exact non-empty event name",
    );
    await expect(scoped.emit("sync-done", ` ${COMPANY_ID} `, {})).rejects.toThrow(
      "exact canonical company UUID",
    );
  });
});
