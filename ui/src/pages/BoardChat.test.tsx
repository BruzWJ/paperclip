// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, forwardRef, useImperativeHandle } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BoardIssueCommentGroupPage } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardChat } from "./BoardChat";

/**
 * Regression coverage for the Conference Room intro on top of the canonical
 * issue-backed Board Chat. A fresh chat requires an explicit agent choice;
 * after that choice it shows the three-dot typing bubble for ~2s, then the
 * welcome, then the suggestion chips ~700ms later. The staged reveal must
 * hold while the onboarding wizard overlay is open or the tab is hidden, and
 * a specifically restored ordinary issue must fast-forward once its creator
 * has already replied.
 */

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listInvokableIssueOwners: vi.fn(),
}));
const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listFeedbackVotes: vi.fn(),
  commitCreatorFormUpdate: vi.fn(),
  selfAssignForWithdrawal: vi.fn(),
  commitOwnerFormUpdate: vi.fn(),
}));
const mockDialogState = vi.hoisted(() => ({ onboardingOpen: false }));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/goals", () => ({ goalsApi: mockGoalsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Acme Robotics", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogState: () => ({ onboardingOpen: mockDialogState.onboardingOpen }),
}));

// Heavy children that are irrelevant to the staged intro.
vi.mock("../components/ActivityFeed", () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/ChatComposer", () => ({
  ChatComposer: forwardRef((props: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
  }, ref) => {
    useImperativeHandle(ref, () => ({ focus: vi.fn() }));
    return (
      <div data-testid="chat-composer">
        <textarea
          data-testid="board-chat-composer-input"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <button type="button" onClick={props.onSubmit}>Send</button>
      </div>
    );
  }),
}));
vi.mock("../components/AgentBubbleActionRow", () => ({
  AgentBubbleActionRow: () => null,
  agentBubbleDateLabel: () => "",
}));
vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SELECTABLE_AGENT = {
  id: "agent-alex",
  name: "Alex",
  title: null,
  status: "active",
  icon: null,
};
const BOARD_ISSUE = {
  id: "issue-board",
  identifier: "PAP-42",
  title: null,
  request: "Hi Alex!",
  lifecycleStatus: "open",
  ownerKind: "agent",
  ownerAgentId: SELECTABLE_AGENT.id,
};
const EMPTY_COMMENT_PAGE = {
  groups: [],
  nextCursor: null,
} satisfies BoardIssueCommentGroupPage;
const USER_COMMENT_PAGE = {
  groups: [{
    root: {
      id: "comment-user-1",
      author: {
        type: "user",
        label: "Test User",
        agentId: null,
        userId: "user-1",
        pluginKey: null,
      },
      body: "Hi Alex!",
      presentation: null,
      metadata: null,
      sourceTrust: null,
      runState: null,
      canonicalSequence: 1,
      immediateParentDisplayReference: null,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    },
    replyCount: 0,
    runSegmentCount: 0,
    entries: [],
    entriesNextCursor: null,
  }],
  nextCursor: null,
} satisfies BoardIssueCommentGroupPage;

function hasTypingDots(container: HTMLElement) {
  return container.querySelectorAll(".typing-dots").length > 0;
}

function hasWelcome(container: HTMLElement) {
  return (container.textContent ?? "").includes("Welcome to");
}

function hasChips(container: HTMLElement) {
  return (container.textContent ?? "").includes("Draft a Company Brief");
}

async function submitComposer(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="board-chat-composer-input"]',
  );
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent === "Send");
  expect(textarea).not.toBeNull();
  expect(button).not.toBeUndefined();
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    textarea!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    button!.click();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("BoardChat staged typing intro", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    mockDialogState.onboardingOpen = false;
    mockAgentsApi.list.mockResolvedValue([SELECTABLE_AGENT]);
    mockAgentsApi.listInvokableIssueOwners.mockResolvedValue([
      {
        id: SELECTABLE_AGENT.id,
        name: SELECTABLE_AGENT.name,
        title: SELECTABLE_AGENT.title,
        icon: SELECTABLE_AGENT.icon,
      },
    ]);
    mockGoalsApi.list.mockResolvedValue([
      { id: "goal-1", title: "Build affordable robots", status: "active" },
    ]);
    mockIssuesApi.get.mockResolvedValue(BOARD_ISSUE);
    mockIssuesApi.listComments.mockResolvedValue(EMPTY_COMMENT_PAGE);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockIssuesApi.selfAssignForWithdrawal.mockResolvedValue({
      issue: {
        ...BOARD_ISSUE,
        ownerKind: "user",
        ownerAgentId: null,
        ownerUserId: "user-1",
        ownerAssignmentSource: "user_creator_withdrawal",
      },
      auditId: "withdrawal-audit",
      retried: false,
    });
    mockIssuesApi.commitOwnerFormUpdate.mockResolvedValue({
      comment: { id: "close-comment" },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
    // Drop any per-test document.visibilityState override.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (document as any).visibilityState;
  });

  let queryClient: QueryClient | null = null;

  function buildElement() {
    // A fresh element every time — rendering an identical element reference
    // lets React bail out of re-rendering, which would hide mock-state flips.
    return (
      <QueryClientProvider client={queryClient!}>
        <BoardChat />
      </QueryClientProvider>
    );
  }

  async function render() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(buildElement());
    });
    // Let the agent/goal/issue queries resolve, plus the follow-up render
    // that enables the comments query off boardIssueId. react-query batches
    // notifications through zero-delay timers, so flush those too.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
  }

  /** Re-render the existing tree so hooks re-read mutated mock state. */
  async function rerender() {
    await act(async () => {
      root!.render(buildElement());
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function selectAgent() {
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Board Chat agent"]',
    );
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = SELECTABLE_AGENT.id;
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("requires an explicit agent, then reveals the welcome and chips in stages", async () => {
    await render();

    // A fresh chat never infers a Lead, primary agent, or other default target.
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Board Chat agent"]',
    );
    expect(select?.value).toBe("");
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);
    await advance(2500);
    expect(hasWelcome(container)).toBe(false);

    await selectAgent();

    // Just before the reveal after the explicit choice: still dots.
    await advance(1900);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // t=2s after the choice: welcome bubble lands, dots leave, chips not yet.
    await advance(100);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
    expect(hasChips(container)).toBe(false);

    // t=2.7s: chips stage in.
    await advance(700);
    expect(hasChips(container)).toBe(true);
  });

  it("skips the staged reveal when a user comment already exists", async () => {
    sessionStorage.setItem(
      "paperclip.boardChat.issue.company-1",
      BOARD_ISSUE.id,
    );
    mockIssuesApi.listComments.mockResolvedValue(USER_COMMENT_PAGE);
    await render();

    // The exact restored issue supplies its immutable owner; Board Chat does
    // not search for a standing conversation or infer an agent by title.
    expect(mockIssuesApi.get).toHaveBeenCalledWith(BOARD_ISSUE.id);
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="Board Chat agent"]',
      )?.value,
    ).toBe(SELECTABLE_AGENT.id);
    expect(hasTypingDots(container)).toBe(false);
    expect(hasWelcome(container)).toBe(true);
  });

  it("preserves initial Board Chat request bytes", async () => {
    const message = " \t前置\nactual newline\\n literal\\r tail\t ";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issueId: "issue-created",
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await render();
    await selectAgent();

    await submitComposer(container, message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      message,
    });
  });

  it("preserves Board Chat creator follow-up bytes", async () => {
    const message = " \t前置\nactual newline\\n literal\\r tail\t ";
    sessionStorage.setItem(
      "paperclip.boardChat.issue.company-1",
      BOARD_ISSUE.id,
    );
    mockIssuesApi.commitCreatorFormUpdate.mockResolvedValue({
      comment: { id: "comment-followup" },
    });
    await render();

    await submitComposer(container, message);

    expect(mockIssuesApi.commitCreatorFormUpdate).toHaveBeenCalledWith({
      issueId: BOARD_ISSUE.id,
      message,
    });
  });

  it("keeps a restored issue mask read-only while its detail is loading", async () => {
    sessionStorage.setItem(
      "paperclip.boardChat.issue.company-1",
      BOARD_ISSUE.id,
    );
    mockIssuesApi.get.mockReturnValue(new Promise(() => {}));
    await render();

    const checkbox = container.querySelector<HTMLButtonElement>(
      '[aria-label="Current issue Content: unchanged"]',
    );
    expect(checkbox).not.toBeNull();
    expect(checkbox?.disabled).toBe(true);
  });

  it("closes a restored chat through withdrawal self-assignment and owner cancellation", async () => {
    sessionStorage.setItem(
      "paperclip.boardChat.issue.company-1",
      BOARD_ISSUE.id,
    );
    await render();

    const newChatButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="new chat"]',
    );
    expect(newChatButton).not.toBeNull();
    await act(async () => {
      newChatButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      mockIssuesApi.selfAssignForWithdrawal,
    ).toHaveBeenCalledWith(
      BOARD_ISSUE.id,
      expect.objectContaining({
        idempotencyKey: expect.any(String),
      }),
    );
    expect(mockIssuesApi.commitOwnerFormUpdate).toHaveBeenCalledWith({
      issueId: BOARD_ISSUE.id,
      message: "Closed from Board Chat.",
      status: "cancelled",
    });
    expect(
      sessionStorage.getItem(
        "paperclip.boardChat.issue.company-1",
      ),
    ).toBeNull();
  });

  it("holds the dots while the onboarding wizard overlay is open (PAP-134)", async () => {
    mockDialogState.onboardingOpen = true;
    await render();
    await selectAgent();

    // The 2s window must not burn behind the wizard overlay.
    await advance(2500);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Wizard closes → reveal timer starts fresh.
    mockDialogState.onboardingOpen = false;
    await rerender();
    await advance(2000);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
  });

  it("holds the dots while the document is hidden (PAP-134)", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    await render();
    await selectAgent();

    // The 2s window must not burn while the tab is hidden.
    await advance(2500);
    expect(hasTypingDots(container)).toBe(true);
    expect(hasWelcome(container)).toBe(false);

    // Tab becomes visible → reveal timer starts fresh.
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(2000);
    expect(hasWelcome(container)).toBe(true);
    expect(hasTypingDots(container)).toBe(false);
  });
});

describe("typing-dots CSS animation guard (PAP-54 failure mode)", () => {
  // PAP-54: the .typing-dots CSS block was silently dropped from index.css
  // during a theme migration, leaving static markup with no animation. Guard
  // the source so the block can't vanish again without failing a test. The
  // browser-computed `animationName !== "none"` assertion lives in
  // tests/e2e/conference-room-typing-intro.spec.ts.
  // Locate ui/src/index.css regardless of whether vitest runs from ui/ or
  // the workspace root (import.meta.url is an http URL under jsdom, and the
  // css pipeline swallows `?raw` imports — plain fs is the reliable path).
  function readIndexCss(): string {
    let dir = process.cwd();
    for (let depth = 0; depth < 6; depth++) {
      for (const candidate of [
        path.join(dir, "src/index.css"),
        path.join(dir, "ui/src/index.css"),
      ]) {
        if (existsSync(candidate)) return readFileSync(candidate, "utf8");
      }
      dir = path.dirname(dir);
    }
    throw new Error("ui/src/index.css not found from " + process.cwd());
  }
  const css = readIndexCss();

  it("keeps the bounce animation wired to .typing-dots span", () => {
    const spanRules = [...css.matchAll(/\.typing-dots span\s*\{[^}]*\}/g)].map(
      (m) => m[0],
    );
    expect(spanRules.length).toBeGreaterThan(0);
    expect(
      spanRules.some((rule) => /animation:\s*typing-bounce/.test(rule)),
    ).toBe(true);
  });

  it("keeps the typing-bounce keyframes", () => {
    expect(css).toMatch(/@keyframes typing-bounce\s*\{/);
  });
});
