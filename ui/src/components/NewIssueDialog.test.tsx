// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "./NewIssueDialog";

const dialogState = vi.hoisted(() => ({
  newIssueOpen: true,
  newIssueDefaults: {} as Record<string, unknown>,
  closeNewIssue: vi.fn(),
}));

const dialogContentState = vi.hoisted(() => ({
  onEscapeKeyDown: null as null | ((event: KeyboardEvent) => void),
  onPointerDownOutside: null as null | ((event: {
    detail: { originalEvent: { target: EventTarget | null } };
    preventDefault: () => void;
  }) => void),
}));

const companyState = vi.hoisted(() => ({
  companies: [
    {
      id: "company-1",
      name: "Paperclip",
      status: "active",
      brandColor: "#123456",
      issuePrefix: "PAP",
    },
  ],
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    brandColor: "#123456",
    issuePrefix: "PAP",
  },
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  create: vi.fn(),
  upsertDocument: vi.fn(),
  uploadAttachment: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listInvokableIssueOwners: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));
const mockMissingUserSecretsBannerRender = vi.hoisted(() => vi.fn());

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => toastState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../pages/secrets/MissingUserSecretsBanner", async () => {
  const React = await import("react");
  return {
    MissingUserSecretsBanner: (props: { definitionKeys?: string[] }) => {
      mockMissingUserSecretsBannerRender(props);
      return React.createElement(
        "div",
        { "data-testid": "missing-user-secrets-banner" },
        props.definitionKeys?.join(",") ?? "",
      );
    },
  };
});

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef<
      { focus: () => void },
      { value: string; onChange?: (value: string) => void; placeholder?: string }
    >(function MarkdownEditorMock({ value, onChange, placeholder }, ref) {
      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
      }));
      return (
        <textarea
          aria-label={placeholder ?? "Description"}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      );
    }),
  };
});

vi.mock("./InlineEntitySelector", async () => {
  const React = await import("react");
  return {
    InlineEntitySelector: React.forwardRef<
      HTMLButtonElement,
      {
        value: string;
        placeholder?: string;
        renderTriggerValue?: (option: { id: string; label: string } | null) => ReactNode;
      }
    >(function InlineEntitySelectorMock({ value, placeholder, renderTriggerValue }, ref) {
      return (
        <button ref={ref} type="button">
          {(renderTriggerValue?.(value ? { id: value, label: value } : null) ?? value) || placeholder}
        </button>
      );
    }),
  };
});

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    onEscapeKeyDown,
    onPointerDownOutside,
    ...props
  }: ComponentProps<"div"> & {
    showCloseButton?: boolean;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onPointerDownOutside?: (event: unknown) => void;
  }) => {
    dialogContentState.onEscapeKeyDown = onEscapeKeyDown ?? null;
    dialogContentState.onPointerDownOutside = onPointerDownOutside as typeof dialogContentState.onPointerDownOutside;
    return <div {...props}>{children}</div>;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/toggle-switch", () => ({
  ToggleSwitch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: () => void }) => (
    <button type="button" aria-pressed={checked} onClick={onCheckedChange}>toggle</button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, disablePortal }: { children: ReactNode; disablePortal?: boolean }) => (
    <div data-disable-portal={String(Boolean(disablePortal))}>{children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  return result && typeof (result as Promise<void>).then === "function"
    ? (result as Promise<void>).then(() => undefined)
    : undefined;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function typeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertText",
      }),
    );
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function renderDialog(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewIssueDialog />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("NewIssueDialog", () => {
  let container: HTMLDivElement;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newIssueOpen = true;
    dialogState.newIssueDefaults = {};
    dialogState.closeNewIssue.mockReset();
    dialogContentState.onEscapeKeyDown = null;
    dialogContentState.onPointerDownOutside = null;
    toastState.pushToast.mockReset();
    mockIssuesApi.create.mockReset();
    mockIssuesApi.upsertDocument.mockReset();
    mockIssuesApi.uploadAttachment.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
      },
    ]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.listInvokableIssueOwners.mockResolvedValue([
      { id: "agent-1", name: "Owner", title: null, icon: null },
    ]);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/uploads/asset.png" });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockMissingUserSecretsBannerRender.mockReset();
    localStorage.clear();
    mockIssuesApi.create.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-2",
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver!;
    document.body.innerHTML = "";
  });

  it("shows sub-issue context only when opened from a sub-issue action", async () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New sub-task");
    expect(container.textContent).toContain("Sub-task of");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Parent issue");
    expect(container.textContent).toContain("Create Sub-Task");

    act(() => root.unmount());

    dialogState.newIssueDefaults = {};
    const rerendered = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New task");
    expect(container.textContent).toContain("Create Task");
    expect(container.textContent).not.toContain("Sub-task of");

    act(() => rerendered.root.unmount());
  });

  it("submits parent and goal context for sub-issues", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: null,
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      goalId: "goal-1",
      ownerAgentId: "agent-1",
      request: "Implement the child issue",
    };

    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(mockExecutionWorkspacesApi.listSummaries).toHaveBeenCalledWith("company-1", {
        projectId: "project-1",
        projectWorkspaceId: undefined,
        reuseEligible: true,
      });
    });
    expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-Task"));
    expect(submitButton).not.toBeUndefined();
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Implement the child issue",
        ownerAgentId: "agent-1",
        idempotencyKey: expect.any(String),
        title: "Child issue",
        parentId: "issue-1",
        goalId: "goal-1",
        projectId: "project-1",
      }),
    );

    act(() => root.unmount());
  });

  it("normalizes persisted raw context access before rendering and submission", async () => {
    localStorage.setItem(
      "paperclip:issue-request-draft:v2",
      JSON.stringify({
        title: "Focused issue",
        request: "Use only the narrowed context",
        status: "todo",
        priority: "medium",
        ownerAgentId: "agent-1",
        reviewerValue: "",
        approverValue: "",
        projectId: "",
        contextAccessMask: {
          carry_context: true,
          read_issue_comments: false,
        },
      }),
    );

    const { root } = renderDialog(container);
    await flush();
    expect(
      container.querySelector(
        '[aria-label="Current issue Content: unchanged"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[aria-label="Current issue Comments: narrowed"]',
      ),
    ).not.toBeNull();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });
    await act(async () => {
      submitButton!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        contextAccessMask: {
          read_issue_comments: false,
        },
      }),
    );
    expect(
      mockIssuesApi.create.mock.calls[0]?.[1]?.contextAccessMask,
    ).not.toHaveProperty("carry_context");

    act(() => root.unmount());
  });

  it("does not show user-secret warnings when the draft will not run an env binding that needs them", async () => {
    const { root } = renderDialog(container);
    await flush();

    expect(mockMissingUserSecretsBannerRender).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("scopes user-secret warnings to selected runnable agent and project env bindings", async () => {
    dialogState.newIssueDefaults = {
      title: "Run with scoped secrets",
      ownerAgentId: "agent-1",
      projectId: "project-1",
    };
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "CodexCoder",
        status: "active",
        adapterType: "codex",
        adapterConfig: {
          env: {
            AGENT_TOKEN: { type: "user_secret_ref", key: "agent_token", required: true },
            OPTIONAL_TOKEN: { type: "user_secret_ref", key: "optional_token", required: false },
          },
        },
        runtimeConfig: {},
        governance: {},
      },
    ]);
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        env: {
          PROJECT_TOKEN: { type: "user_secret_ref", key: "project_token", required: true },
        },
      },
    ]);

    const { root } = renderDialog(container);
    await waitForAssertion(() => {
      expect(mockMissingUserSecretsBannerRender).toHaveBeenCalledWith(
        expect.objectContaining({
          definitionKeys: ["agent_token", "project_token"],
        }),
      );
    });

    expect(container.textContent).toContain("agent_token,project_token");

    act(() => root.unmount());
  });

  it("restores the planning mode from dialog defaults", async () => {
    dialogState.newIssueDefaults = {
      title: "Planned from defaults",
      request: "Plan this work from defaults",
      workMode: "planning",
      ownerAgentId: "agent-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const planningButton = container.querySelector('[data-issue-work-mode="planning"]');
    expect(planningButton?.className).toContain("bg-accent");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Plan this work from defaults",
        ownerAgentId: "agent-1",
        title: "Planned from defaults",
      }),
    );

    act(() => root.unmount());
  });

  it("restores ask mode from dialog defaults", async () => {
    dialogState.newIssueDefaults = {
      title: "Question from defaults",
      request: "Answer this question from defaults",
      workMode: "ask",
      ownerAgentId: "agent-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const askButton = container.querySelector('[data-issue-work-mode="ask"]');
    expect(askButton?.className).toContain("bg-accent");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Answer this question from defaults",
        ownerAgentId: "agent-1",
        title: "Question from defaults",
      }),
    );

    act(() => root.unmount());
  });

  it("submits request-only defaults without inventing a title", async () => {
    dialogState.newIssueDefaults = {
      request: "Implement the immutable request",
      ownerAgentId: "agent-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Implement the immutable request",
        ownerAgentId: "agent-1",
      }),
    );
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).not.toHaveProperty("title");

    act(() => root.unmount());
  });

  it("applies project and execution workspace defaults for normal new issues", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        workspaces: [
          {
            id: "project-workspace-1",
            name: "Primary",
            isPrimary: true,
          },
          {
            id: "project-workspace-2",
            name: "Isolated checkout",
            isPrimary: false,
          },
        ],
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "PAP-100",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-100",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: "project-workspace-2",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      title: "Follow-up issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-2",
      executionWorkspaceId: "workspace-1",
      ownerAgentId: "agent-1",
      request: "Investigate the follow-up",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New task");
    expect(container.textContent).not.toContain("New sub-task");
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Reusing PAP-100");
    });

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Investigate the follow-up",
        ownerAgentId: "agent-1",
        idempotencyKey: expect.any(String),
        title: "Follow-up issue",
        projectId: "project-1",
        projectWorkspaceId: "project-workspace-2",
      }),
    );
    const createPayload = mockIssuesApi.create.mock.calls[0]?.[1];
    expect(createPayload).not.toHaveProperty("executionWorkspaceId");
    expect(createPayload).not.toHaveProperty("executionWorkspacePreference");
    expect(createPayload).not.toHaveProperty("executionWorkspaceSettings");

    act(() => root.unmount());
  });

  it("keeps the reusable workspace search popover inside the modal", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        workspaces: [
          {
            id: "project-workspace-1",
            name: "Primary",
            isPrimary: true,
          },
        ],
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "PAP-11446-on-mobile-the-agent-chat",
        mode: "isolated_workspace",
        status: "active",
        branchName: "PAP-11446-on-mobile-the-agent-chat",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: "project-workspace-1",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      title: "Follow-up issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
    };

    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      const workspaceInput = container.querySelector('input[placeholder="Search workspaces..."]');
      expect(workspaceInput?.closest("[data-disable-portal]")?.getAttribute("data-disable-portal")).toBe("true");
    });

    act(() => root.unmount());
  });

  it("submits the latest locally typed optional title and immutable request", async () => {
    dialogState.newIssueDefaults = {
      ownerAgentId: "agent-1",
    };
    let resolveProjects: (projects: Array<{
      id: string;
      name: string;
      description: string | null;
      archivedAt: string | null;
      color: string;
    }>) => void = () => undefined;
    mockProjectsApi.list.mockReturnValue(new Promise((resolve) => {
      resolveProjects = resolve;
    }));

    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Optional task title"]') as HTMLTextAreaElement | null;
    const requestInput = container.querySelector('textarea[aria-label="Describe the request..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(requestInput).not.toBeNull();

    await typeTextareaValue(titleInput!, "Typed issue");
    await typeTextareaValue(requestInput!, "Typed request");

    await act(async () => {
      resolveProjects([
        {
          id: "project-1",
          name: "Alpha",
          description: null,
          archivedAt: null,
          color: "#445566",
        },
      ]);
      await Promise.resolve();
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Typed request",
        ownerAgentId: "agent-1",
        idempotencyKey: expect.any(String),
        title: "Typed issue",
      }),
    );
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).not.toHaveProperty("description");
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).not.toHaveProperty("workMode");

    act(() => root.unmount());
  });

  it("submits immutable request bytes without normalization", async () => {
    const title = "验证中文任务";
    const request = [
      " \t请用中文回复。",
      "日本語: 次の手順を書いてください。",
      "हिन्दी: कृपया स्थिति बताएं।",
      "literal\\n and literal\\r remain text\t ",
    ].join("\n");
    dialogState.newIssueDefaults = {
      ownerAgentId: "agent-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Optional task title"]') as HTMLTextAreaElement | null;
    const requestInput = container.querySelector('textarea[aria-label="Describe the request..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(requestInput).not.toBeNull();

    await typeTextareaValue(titleInput!, title);
    await typeTextareaValue(requestInput!, request);

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request,
        ownerAgentId: "agent-1",
        idempotencyKey: expect.any(String),
        title,
      }),
    );
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).not.toHaveProperty("description");
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).not.toHaveProperty("workMode");

    act(() => root.unmount());
  });

  it("submits planning work mode when planning is selected", async () => {
    dialogState.newIssueDefaults = {
      ownerAgentId: "agent-1",
    };
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Optional task title"]') as HTMLTextAreaElement | null;
    const requestInput = container.querySelector('textarea[aria-label="Describe the request..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(requestInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Plan this first");
    await typeTextareaValue(requestInput!, "Plan this first");

    const planningButton = container.querySelector('[data-issue-work-mode="planning"]');
    expect(planningButton).not.toBeNull();
    await act(async () => {
      planningButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Plan this first",
        ownerAgentId: "agent-1",
        idempotencyKey: expect.any(String),
        title: "Plan this first",
      }),
    );
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).not.toHaveProperty("workMode");

    act(() => root.unmount());
  });

  it("submits ask work mode when ask is selected", async () => {
    dialogState.newIssueDefaults = {
      ownerAgentId: "agent-1",
    };
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Optional task title"]') as HTMLTextAreaElement | null;
    const requestInput = container.querySelector('textarea[aria-label="Describe the request..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(requestInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Answer this first");
    await typeTextareaValue(requestInput!, "Answer this first");

    const askButton = container.querySelector('[data-issue-work-mode="ask"]');
    expect(askButton).not.toBeNull();
    await act(async () => {
      askButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Answer this first",
        ownerAgentId: "agent-1",
        idempotencyKey: expect.any(String),
        title: "Answer this first",
      }),
    );
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).not.toHaveProperty("workMode");

    act(() => root.unmount());
  });

  it("cycles work modes with cmd-period", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-issue-work-mode-chip]");
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("ask");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    act(() => root.unmount());
  });

  it("cycles work modes when iOS reports cmd-period as Escape", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-issue-work-mode-chip]");
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");
    expect(dialogContentState.onEscapeKeyDown).not.toBeNull();

    const commandPeriodAsEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      metaKey: true,
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(commandPeriodAsEscape);
    });

    expect(commandPeriodAsEscape.defaultPrevented).toBe(true);
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");
    expect(dialogState.closeNewIssue).not.toHaveBeenCalled();

    const plainEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(plainEscape);
    });

    expect(plainEscape.defaultPrevented).toBe(false);
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    const controlEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "Escape",
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(controlEscape);
    });

    expect(controlEscape.defaultPrevented).toBe(false);
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    act(() => root.unmount());
  });

  it("cycles work modes with ctrl-period", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-issue-work-mode-chip]");
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        ctrlKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    act(() => root.unmount());
  });

  it("submits the parent owner when a sub-issue opens with inherited defaults", async () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      goalId: "goal-1",
      ownerAgentId: "agent-1",
      request: "Implement the child issue",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        request: "Implement the child issue",
        ownerAgentId: "agent-1",
        idempotencyKey: expect.any(String),
        title: "Child issue",
        parentId: "issue-1",
        goalId: "goal-1",
        projectId: "project-1",
      }),
    );

    act(() => root.unmount());
  });

  it("clears a persisted draft owner that is absent from the current invokable catalog", async () => {
    localStorage.setItem(
      "paperclip:issue-request-draft:v2",
      JSON.stringify({
        title: "Stale owner draft",
        request: "Do not dispatch this to the old owner",
        status: "todo",
        priority: "medium",
        ownerAgentId: "agent-stale",
        reviewerValue: "",
        approverValue: "",
        projectId: "",
      }),
    );
    mockAgentsApi.listInvokableIssueOwners.mockResolvedValue([
      { id: "agent-current", name: "Current owner", title: null, icon: null },
    ]);

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(true);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockIssuesApi.create).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("keeps the mobile dialog bounded with an internal flexible scroll region", async () => {
    const { root } = renderDialog(container);
    await flush();

    const dialogContent = Array.from(container.querySelectorAll("div")).find((element) =>
      typeof element.className === "string" && element.className.includes("max-h-(--new-issue-dialog-height)"),
    );
    expect(dialogContent?.className).toContain("h-(--new-issue-dialog-height)");
    expect(dialogContent?.className).toContain("overflow-hidden");
    expect(dialogContent?.getAttribute("style")).toContain("env(safe-area-inset-top)");
    expect(dialogContent?.getAttribute("style")).toContain("env(safe-area-inset-bottom)");

    const titleInput = container.querySelector('textarea[placeholder="Optional task title"]');
    const requestInput = container.querySelector('textarea[aria-label="Describe the request..."]');
    const bodyScrollRegion = Array.from(container.querySelectorAll("div")).find((element) =>
      typeof element.className === "string" && element.className.includes("overscroll-contain"),
    );
    expect(bodyScrollRegion?.className).toContain("flex-1");
    expect(bodyScrollRegion?.className).toContain("overflow-y-auto");
    expect(bodyScrollRegion?.contains(titleInput ?? null)).toBe(true);
    expect(bodyScrollRegion?.contains(requestInput ?? null)).toBe(true);

    act(() => root.unmount());
  });

  it("keeps priority under the mobile overflow menu", async () => {
    const { root } = renderDialog(container);
    await flush();

    const priorityChip = container.querySelector('[data-testid="new-issue-priority-chip"]');
    expect(priorityChip?.className).toContain("hidden");
    expect(priorityChip?.className).toContain("sm:inline-flex");

    const highPriorityOption = container.querySelector('[data-testid="new-issue-more-priority-high"]');
    expect(highPriorityOption?.textContent).toContain("High");

    await act(async () => {
      highPriorityOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const selectedHighPriorityOption = container.querySelector('[data-testid="new-issue-more-priority-high"]');
    expect(selectedHighPriorityOption?.className).toContain("bg-accent");

    act(() => root.unmount());
  });

  it("allows editor autocomplete portal pointer events inside the modal", async () => {
    const { root } = renderDialog(container);
    await flush();

    const menu = document.createElement("div");
    menu.setAttribute("data-paperclip-floating-ui", "");
    const option = document.createElement("button");
    menu.appendChild(option);
    document.body.appendChild(menu);
    const preventDefault = vi.fn();

    dialogContentState.onPointerDownOutside?.({
      detail: { originalEvent: { target: option } },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("warns when a sub-issue stops matching the parent workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: null,
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
      {
        id: "workspace-2",
        name: "Other workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-2",
        cwd: "/tmp/workspace-2",
        projectWorkspaceId: null,
        lastUsedAt: new Date("2026-04-06T16:01:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      parentExecutionWorkspaceLabel: "Parent workspace",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();
    await flush();

    expect(container.textContent).not.toContain("will no longer use the parent task workspace");

    const selects = Array.from(container.querySelectorAll("select"));
    const modeSelect = selects[0] as HTMLSelectElement | undefined;
    expect(modeSelect).not.toBeUndefined();

    await act(async () => {
      modeSelect!.value = "shared_workspace";
      modeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("will no longer use the parent task workspace");
    expect(container.textContent).toContain("Parent workspace");

    act(() => root.unmount());
  });

  describe("graduated work-mode labels and status hues", () => {
    function workModeOption(value: string) {
      return container.querySelector(`[data-issue-work-mode="${value}"]`);
    }

    function statusOptionIconClass(label: string, description?: string) {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) => {
        const text = candidate.textContent ?? "";
        return (
          candidate.querySelector("svg") !== null &&
          text.includes(label) &&
          (description === undefined || text.includes(description))
        );
      });
      return button?.querySelector("svg")?.getAttribute("class") ?? "";
    }

    it("uses agent-mode labels and brand status hues by default", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(workModeOption("standard")?.textContent).toContain("Agent mode");
      });

      expect(workModeOption("standard")?.textContent).toContain("Agent mode");
      expect(workModeOption("ask")?.textContent).toContain("Ask mode");
      expect(workModeOption("planning")?.textContent).toContain("Plan mode");

      expect(statusOptionIconClass("Todo", "Executable - owner will be woken")).toContain("text-amber-600");
      expect(statusOptionIconClass("In Progress")).toContain("text-blue-600");

      act(() => root.unmount());
    });
  });
});
