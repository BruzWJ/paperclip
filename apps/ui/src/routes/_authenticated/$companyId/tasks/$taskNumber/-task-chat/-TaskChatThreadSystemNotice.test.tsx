// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatThread } from "./-TaskChatThread";
import type { TaskChatComment } from "@/lib/task-chat-messages";

vi.mock("../../../../../../features/markdown/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../../../../../features/markdown/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Task chat editor" />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../../../../../../features/agents/AgentIconPicker", () => ({ AgentIcon: () => null }));
vi.mock("../../../../../../features/tasks/shared/TaskLinkQuicklook", () => ({
  TaskLinkQuicklook: ({
    children,
    taskId: _taskId,
    taskNumber,
  }: {
    children: ReactNode;
    taskId: string;
    taskNumber: number | null;
  }) => <a href={`/11111111-1111-4111-8111-111111111111/tasks/${taskNumber}`}>{children}</a>,
}));
vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: ComponentProps<"a"> & { to: string; params?: Record<string, string> }) => {
    const href = to.replace("$companyId", params?.companyId ?? "").replace("$agentId", params?.agentId ?? "");
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
  useLocation: () => ({ hash: "" }),
}));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  window.scrollTo = vi.fn();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

function renderThread(comments: TaskChatComment[]) {
  act(() => {
    root.render(<TaskChatThread comments={comments} onAdd={async () => {}} showComposer={false} />);
  });
}

async function openMessageActions(row: ParentNode = container) {
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

const baseTimestamps = {
  createdAt: new Date("2026-05-04T16:32:00.000Z"),
};

describe("TaskChatThread system notice routing", () => {
  it("renders authorType=system comments as a SystemNotice rather than a user bubble", () => {
    const comment: TaskChatComment = {
      id: "comment-system",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: "Paperclip needs a disposition before this task can continue.",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Missing task disposition",
        detailsDefaultOpen: false,
      },
      metadata: {
        version: 1,
        sections: [
          {
            title: "Required action",
            rows: [
              {
                type: "task_link",
                label: "Source task",
                taskId: "123e4567-e89b-42d3-a456-426614174000",
                taskNumber: 3440,
                identifier: "PAP-3440",
                title: "Recovery",
              },
              {
                type: "key_value",
                label: "Status before",
                value: "in_progress",
              },
            ],
          },
        ],
      },
      ...baseTimestamps,
    };

    renderThread([comment]);

    const row = container.querySelector('[data-message-role="system"]');
    expect(row).not.toBeNull();
    const status = row?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("Missing task disposition");
    expect(container.textContent).toContain("Paperclip needs a disposition");
    // collapsed by default — metadata identifier should not be visible
    expect(container.textContent).not.toContain("PAP-3440");
    const toggle = [...(row?.querySelectorAll("button[aria-expanded]") ?? [])].find((button) =>
      button.textContent?.includes("Details"),
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll('[data-message-role="user"]').length).toBe(0);
  });

  it("expands metadata when detailsDefaultOpen is true", () => {
    const comment: TaskChatComment = {
      id: "comment-system-open",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: "Recovery escalated.",
      presentation: {
        kind: "system_notice",
        tone: "danger",
        title: null,
        detailsDefaultOpen: true,
      },
      metadata: {
        version: 1,
        sections: [
          {
            rows: [
              {
                type: "agent_link",
                label: "Owner",
                agentId: "agent-architect",
                name: "Architect",
              },
            ],
          },
        ],
      },
      ...baseTimestamps,
    };

    renderThread([comment]);

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("System alert");
    expect(container.textContent).toContain("Architect");
    const toggle = [...container.querySelectorAll("button[aria-expanded]")].find((button) =>
      button.textContent?.includes("Details"),
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps regular user comments rendering as user bubbles", () => {
    const comment: TaskChatComment = {
      id: "comment-user",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Standard user message.",
      presentation: null,
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-message-role="user"]')).not.toBeNull();
    expect(container.textContent).toContain("Standard user message.");
  });

  it("keeps agent-authored comments rendering as assistant bubbles even with system_notice presentation absent", () => {
    const comment: TaskChatComment = {
      id: "comment-agent",
      authorType: "agent",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Agent reply",
      presentation: null,
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-message-role="assistant"]')).not.toBeNull();
  });

  it("copies a system-notice permalink from the compact message menu", async () => {
    const writeText = vi.fn(async () => undefined);
    const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const comment: TaskChatComment = {
      id: "comment-copy-link",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: "System recovery completed.",
      presentation: {
        kind: "system_notice",
        tone: "success",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    const trigger = await openMessageActions();
    const copyLink = [...document.body.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Copy link to system notice"),
    ) as HTMLElement;
    await act(async () => {
      copyLink.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("#comment-comment-copy-link"));
    expect(trigger.querySelector(".lucide-check")).not.toBeNull();
    if (originalSecureContext) {
      Object.defineProperty(window, "isSecureContext", originalSecureContext);
    } else {
      // @ts-expect-error test cleanup for optional browser API
      delete window.isSecureContext;
    }
  });

  it("labels system notice source as Paperclip when no run agent can be resolved", () => {
    const comment: TaskChatComment = {
      id: "comment-system-no-author",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: "System recovery completed.",
      presentation: {
        kind: "system_notice",
        tone: "info",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("Paperclip");
    expect(status?.textContent).not.toContain("You");
  });

  it("keeps agent-authored comments as assistant bubbles even when presentation requests system_notice", () => {
    const comment: TaskChatComment = {
      id: "comment-agent-system",
      authorType: "agent",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Reassigned to ClaudeFixer.",
      presentation: {
        kind: "system_notice",
        tone: "neutral",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-message-role="assistant"]')).not.toBeNull();
  });
});
