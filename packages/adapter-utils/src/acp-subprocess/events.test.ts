import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  InvalidAcpSessionUpdate,
  normalizeAcpSessionUpdate,
} from "./events.js";

function notification(
  update: SessionNotification["update"],
): SessionNotification {
  return { sessionId: "session-1", update };
}

describe("ACP session update normalization", () => {
  it("classifies provider user-message output as a non-durable echo", () => {
    expect(
      normalizeAcpSessionUpdate(
        notification({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "exact input" },
        }),
      ),
    ).toEqual({
      kind: "user_message_echo",
      content: { type: "text", text: "exact input" },
    });
  });

  it("maps the stable anonymous plan to an exact redacted replacement", () => {
    const event = normalizeAcpSessionUpdate(
      notification({
        sessionUpdate: "plan",
        _meta: { secret: "outer" },
        entries: [
          {
            content: "Implement",
            priority: "high",
            status: "in_progress",
            _meta: { secret: "inner" },
          },
          {
            content: "Verify",
            priority: "low",
            status: "pending",
          },
        ],
      }),
    );
    expect(event).toEqual({
      kind: "plan",
      entries: [
        {
          content: "Implement",
          priority: "high",
          status: "in_progress",
        },
        { content: "Verify", priority: "low", status: "pending" },
      ],
    });
  });

  it.each(["plan_update", "plan_removed"] as const)(
    "rejects experimental %s",
    (sessionUpdate) => {
      expect(() =>
        normalizeAcpSessionUpdate(
          notification(
            sessionUpdate === "plan_update"
              ? {
                  sessionUpdate,
                  plan: {
                    type: "markdown",
                    planId: "plan-1",
                    content: "no",
                  },
                }
              : { sessionUpdate, planId: "plan-1" },
          ),
        ),
      ).toThrow(InvalidAcpSessionUpdate);
    },
  );

  it("preserves occupancy and optional cost without inventing totals", () => {
    expect(
      normalizeAcpSessionUpdate(
        notification({ sessionUpdate: "usage_update", used: 0, size: 100 }),
      ),
    ).toEqual({ kind: "usage", used: 0, size: 100, cost: null });
    expect(
      normalizeAcpSessionUpdate(
        notification({
          sessionUpdate: "usage_update",
          used: 20,
          size: 100,
          cost: { amount: 0, currency: "USD" },
        }),
      ),
    ).toEqual({
      kind: "usage",
      used: 20,
      size: 100,
      cost: { amount: 0, currency: "USD" },
    });
    expect(
      normalizeAcpSessionUpdate(
        notification({
          sessionUpdate: "usage_update",
          used: 20,
          size: 100,
          cost: { amount: -1, currency: "usd" },
        }),
      ),
    ).toEqual({
      kind: "usage",
      used: 20,
      size: 100,
      cost: { amount: -1, currency: "usd" },
    });
  });

  it("removes ACP metadata recursively from durable event candidates", () => {
    expect(
      normalizeAcpSessionUpdate(
        notification({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read",
          rawInput: { path: "README.md", _meta: { token: "secret" } },
          _meta: { token: "outer" },
        }),
      ),
    ).toEqual({
      kind: "tool_call",
      toolCallId: "tool-1",
      title: "Read",
      rawInput: { path: "README.md" },
    });
  });
});
