// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskChatThread } from "./TaskChatThread";
import type { TaskChatComment } from "../lib/task-chat-messages";
import type { Agent } from "@paperclipai/shared";

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useAui: () => ({ thread: () => ({ append: async () => undefined }) }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Task chat editor" />,
}));

vi.mock("./InlineEntitySelector", () => ({ InlineEntitySelector: () => null }));
vi.mock("./Identity", () => ({ Identity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./AgentIconPicker", () => ({ AgentIcon: () => null }));
vi.mock("./StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("./TaskLinkQuicklook", () => ({
  TaskLinkQuicklook: ({
    children,
    to,
  }: {
    children: ReactNode;
    to: string;
  }) => <a href={to}>{children}</a>,
}));
vi.mock("../hooks/usePaperclipTaskRuntime", () => ({
  usePaperclipTaskRuntime: () => ({}),
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

function renderThread(
  comments: TaskChatComment[],
  options: {
    agentMap?: Map<string, Agent>;
    taskStatus?: string;
  } = {},
) {
  act(() => {
    root.render(
      <MemoryRouter>
        <TaskChatThread
          comments={comments}
          timelineEvents={[]}
          onAdd={async () => {}}
          showComposer={false}
          agentMap={options.agentMap}
          taskStatus={options.taskStatus}
        />
      </MemoryRouter>,
    );
  });
}

const baseTimestamps = {
  createdAt: new Date("2026-05-04T16:32:00.000Z"),
  updatedAt: new Date("2026-05-04T16:32:00.000Z"),
};

describe("TaskChatThread system notice routing", () => {
  it("renders authorType=system comments as a SystemNotice rather than a user bubble", () => {
    const comment: TaskChatComment = {
      id: "comment-system",
      companyId: "company-1",
      taskId: "task-1",
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
              { type: "task_link", label: "Source task", taskId: "i1", identifier: "PAP-3440", title: "Recovery" },
              { type: "key_value", label: "Status before", value: "in_progress" },
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
    const toggle = row?.querySelector("button[aria-expanded]") as HTMLButtonElement | null;
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll('[data-message-role="user"]').length).toBe(0);
  });

  it("expands metadata when detailsDefaultOpen is true", () => {
    const comment: TaskChatComment = {
      id: "comment-system-open",
      companyId: "company-1",
      taskId: "task-1",
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
              { type: "agent_link", label: "Owner", agentId: "agent-architect", name: "Architect" },
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
    const toggle = container.querySelector("button[aria-expanded]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps regular user comments rendering as user bubbles", () => {
    const comment: TaskChatComment = {
      id: "comment-user",
      companyId: "company-1",
      taskId: "task-1",
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
      companyId: "company-1",
      taskId: "task-1",
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

  it("labels system notice source as the originating run agent name when runAgentId is available", () => {
    const codexAgent = {
      id: "agent-codex",
      name: "CodexCoder",
    } as unknown as Agent;
    const agentMap = new Map<string, Agent>([[codexAgent.id, codexAgent]]);
    const comment: TaskChatComment = {
      id: "comment-system-runagent",
      companyId: "company-1",
      taskId: "task-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      runId: "run-task-chat-01",
      runAgentId: "agent-codex",
      body: "Paperclip needs a disposition before this task can continue.",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Missing task disposition",
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment], { agentMap });

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    const sourceLink = status?.querySelector('a[href^="/agents/"]') as HTMLAnchorElement | null;
    expect(sourceLink?.getAttribute("href")).toBe("/agents/agent-codex/runs/run-task-chat-01");
    expect(sourceLink?.textContent).toBe("CodexCoder");
    expect(sourceLink?.textContent).not.toBe("You");
  });

  it("shows copy-link feedback on the link button only", async () => {
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
      companyId: "company-1",
      taskId: "task-1",
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

    const copyLink = container.querySelector('button[aria-label="Copy link to system notice"]') as HTMLButtonElement;
    const copyText = container.querySelector('button[aria-label="Copy system notice"]') as HTMLButtonElement;
    await act(async () => {
      copyLink.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("#comment-comment-copy-link"));
    expect(copyLink.querySelector(".lucide-check")).not.toBeNull();
    expect(copyText.querySelector(".lucide-check")).toBeNull();
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
      companyId: "company-1",
      taskId: "task-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      runId: null,
      runAgentId: null,
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

  it("falls back to Paperclip in the system notice header when run agent is unknown to agentMap", () => {
    const comment: TaskChatComment = {
      id: "comment-system-unknown-agent",
      companyId: "company-1",
      taskId: "task-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      runId: "run-xyz",
      runAgentId: "agent-unknown",
      body: "Disposition required.",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    const status = container.querySelector('[role="status"]');
    const sourceLink = status?.querySelector('a[href^="/agents/"]') as HTMLAnchorElement | null;
    expect(sourceLink?.getAttribute("href")).toBe("/agents/agent-unknown/runs/run-xyz");
    expect(sourceLink?.textContent).toBe("Paperclip");
  });

  it("keeps agent-authored comments as assistant bubbles even when presentation requests system_notice", () => {
    const comment: TaskChatComment = {
      id: "comment-agent-system",
      companyId: "company-1",
      taskId: "task-1",
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
