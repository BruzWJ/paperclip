import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

import { logger } from "../middleware/logger.js";
import { createPluginDomainEventPublisher } from "./plugin-domain-event-publisher.js";
import { createPluginEventBus } from "./plugin-event-bus.js";

const event = {
  eventId: "comment-1",
  eventType: "issue.board.comment.created" as const,
  occurredAt: "2026-08-06T00:00:00.000Z",
  companyId: "company-1",
  entityId: "comment-1",
  entityType: "issue_comment",
  payload: { issueId: "issue-1", commentId: "comment-1" },
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
      "issue.board.comment.created",
      async () => {
        await blocked;
        completed();
      },
    );
    bus.forPlugin("paperclip.failed").subscribe(
      "issue.board.comment.created",
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
        pluginId: "paperclip.failed",
        eventType: "issue.board.comment.created",
      }),
      "plugin event handler failed",
    );
  });
});
