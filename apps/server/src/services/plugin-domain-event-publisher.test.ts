import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import { logger } from "../middleware/logger.js";
import { createPluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import { createPluginEventBus } from "./plugin-event-bus.js";

const event = {
  eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  eventType: "task.board.comment.created" as const,
  occurredAt: "2026-08-06T00:00:00.000Z",
  companyId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  entityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  entityType: "task_comment",
  payload: {
    taskId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    commentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
};

describe("plugin domain event publisher", () => {
  it("awaits handlers and logs each isolated plugin failure", async () => {
    const bus = createPluginEventBus();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = vi.fn();
    bus.forPlugin("paperclip.blocked").subscribe(
      "task.board.comment.created",
      async () => {
        await blocked;
        completed();
      },
    );
    bus.forPlugin("paperclip.failed").subscribe(
      "task.board.comment.created",
      async () => {
        throw new Error("handler failed");
      },
    );

    let settled = false;
    const publishing = createPluginDomainEventPublisher(bus)
      .publish(event)
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await publishing;
    expect(completed).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginKey: "paperclip.failed",
        eventType: "task.board.comment.created",
      }),
      "plugin event handler failed",
    );
  });
});
