// @vitest-environment jsdom

import type { Agent } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskChatMessage } from "@/lib/task-chat-messages";
import { TaskChatCtx, type TaskChatMessageContext } from "./-TaskChatShared";
import { TaskChatMessageRow } from "./-TaskChatMessageRow";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/hooks/useCompanyRouteId", () => ({ useCompanyRouteId: () => "company-1" }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function message(id: string, role: TaskChatMessage["role"], custom: Record<string, unknown>) {
  return {
    id,
    role,
    createdAt: new Date("2026-08-15T16:00:00.000Z"),
    content: [{ type: "text", text: `${id} body` }],
    metadata: { custom: { kind: "comment", anchorId: `comment-${id}`, commentId: id, ...custom } },
  } satisfies TaskChatMessage;
}

function renderRows(messages: TaskChatMessage[], context: TaskChatMessageContext) {
  act(() => {
    root.render(
      <TaskChatCtx.Provider value={context}>
        {messages.map((item) => (
          <TaskChatMessageRow key={item.id} message={item} />
        ))}
      </TaskChatCtx.Provider>,
    );
  });
}

async function openActions(row: Element) {
  const trigger = [...row.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Message actions"),
  )!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  return trigger;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TaskChatMessageRow sender layout", () => {
  it("distinguishes the current user, another member, an agent, and a plugin", () => {
    const agent = { id: "agent-1", name: "Research agent", icon: "search" } as unknown as Agent;
    renderRows(
      [
        message("self", "user", { authorType: "user", authorName: "You", authorUserId: "user-1" }),
        message("member", "user", {
          authorType: "user",
          authorName: "Maya Chen",
          authorUserId: "user-2",
        }),
        message("agent", "assistant", {
          authorType: "agent",
          authorName: agent.name,
          authorAgentId: agent.id,
        }),
        message("plugin", "assistant", {
          authorType: "plugin",
          authorName: "Deployment automation",
        }),
      ],
      {
        currentUserId: "user-1",
        agentMap: new Map([[agent.id, agent]]),
        userProfileMap: new Map([
          ["user-1", { label: "Avery Stone", image: "/avery.png" }],
          ["user-2", { label: "Maya Chen", image: null }],
        ]),
      },
    );

    const self = container.querySelector("#comment-self")!;
    const member = container.querySelector("#comment-member")!;
    const agentRow = container.querySelector("#comment-agent")!;
    const plugin = container.querySelector("#comment-plugin")!;
    expect(self.querySelector(".is-user")).not.toBeNull();
    expect(self.querySelector('[data-slot="avatar"]')?.textContent).toBe("AS");
    expect(member.querySelector(".is-assistant")).not.toBeNull();
    expect(member.textContent).toContain("Member");
    expect(agentRow.textContent).toContain("Research agent");
    expect(agentRow.textContent).toContain("Agent");
    expect(agentRow.querySelector(".lucide-search")).not.toBeNull();
    expect(plugin.textContent).toContain("Deployment automation");
    expect(plugin.textContent).toContain("Plugin");
    expect(plugin.querySelector(".lucide-plug")).not.toBeNull();
  });

  it("keeps message commands behind one compact action trigger", async () => {
    const onReply = vi.fn();
    const item = message("replyable", "user", {
      authorType: "user",
      authorName: "Maya Chen",
      authorUserId: "user-2",
      canReply: true,
    });
    renderRows([item], { currentUserId: "user-1", onReply });

    const row = container.querySelector("#comment-replyable")!;
    expect(
      [...row.querySelectorAll("button")].filter((button) => button.textContent?.includes("Message actions")),
    ).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Copy link to message");
    await openActions(row);
    const menuItems = [...document.body.querySelectorAll('[role="menuitem"]')];
    expect(menuItems.map((menuItem) => menuItem.textContent)).toEqual([
      "Copy message",
      "Copy link to message",
      "Reply",
    ]);

    await act(async () => {
      (menuItems[2] as HTMLElement).click();
      await Promise.resolve();
    });
    expect(onReply).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: "replyable", authorLabel: "Maya Chen" }),
    );
  });
});
