// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, buildSearchState } from ".";
import { TestRouter } from "@/test/TestRouter";
import { getRouteComponent } from "@/test/route-component";

const Search = getRouteComponent(Route);

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const dialogState = vi.hoisted(() => ({
  openNewTask: vi.fn(),
}));

const searchApiMock = vi.hoisted(() => ({
  search: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const projectsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const tasksApiMock = vi.hoisted(() => ({
  listLabels: vi.fn(),
}));

const authApiMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const AUTH_TASK_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_TASK_ID = "55555555-5555-4555-8555-555555555555";
const CONTINUATION_TASK_ID = "66666666-6666-4666-8666-666666666666";

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => dialogState,
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("@/api/search", () => ({
  searchApi: searchApiMock,
}));

vi.mock("@/api/agents", () => ({
  agentsApi: agentsApiMock,
}));

vi.mock("@/api/projects", () => ({
  projectsApi: projectsApiMock,
}));

vi.mock("@/api/tasks", () => ({
  tasksApi: tasksApiMock,
}));

vi.mock("@/api/auth", () => ({
  authApi: authApiMock,
}));

vi.mock("@/components/StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span data-status={status} />,
}));

vi.mock("@/components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => (
    <span data-status-badge={status}>{status}</span>
  ),
}));

vi.mock("@/components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
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

async function getSearchInput(
  container: HTMLElement,
): Promise<HTMLInputElement> {
  let input: HTMLInputElement | null = null;
  await waitForAssertion(() => {
    input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search query"]',
    );
    expect(input).not.toBeNull();
  });
  return input!;
}

function renderSearch(
  initialPath: string,
  container: HTMLDivElement,
  node?: ReactNode,
) {
  const root = createRoot(container);
  const routerRef: { current: AnyRouter | null } = { current: null };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TestRouter initialEntries={[initialPath]} routerRef={routerRef}>
          {node ?? <Search />}
        </TestRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient, routerRef };
}

describe("buildSearchState", () => {
  it("writes q and a non-default scope", () => {
    expect(buildSearchState("auth flake", "comments")).toMatchObject({
      q: "auth flake",
      scope: "comments",
    });
  });

  it("omits empty query and default search values", () => {
    expect(buildSearchState("   ", "all")).toMatchObject({
      q: undefined,
      scope: undefined,
      sort: undefined,
    });
  });

  it("returns typed filter arrays and the exact canonical owner id", () => {
    expect(
      buildSearchState(
        "release",
        "tasks",
        {
          status: ["todo"],
          priority: ["high"],
          ownerAgentId: "33333333-3333-4333-8333-333333333333",
        },
        "updated",
      ),
    ).toMatchObject({
      q: "release",
      scope: "tasks",
      sort: "updated",
      status: ["todo"],
      priority: ["high"],
      ownerAgentId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("rejects contradictory owner filter state", () => {
    expect(() =>
      buildSearchState("release", "tasks", {
        ownerAgentId: "33333333-3333-4333-8333-333333333333",
        ownerUserId: "user-1",
      }),
    ).toThrow(
      "Search filters cannot contain both an agent owner and a user owner",
    );
  });
});

describe("Search page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    dialogState.openNewTask.mockReset();
    searchApiMock.search.mockReset();
    agentsApiMock.list.mockReset();
    projectsApiMock.list.mockReset();
    tasksApiMock.listLabels.mockReset();
    authApiMock.getSession.mockReset();
    agentsApiMock.list.mockResolvedValue([]);
    projectsApiMock.list.mockResolvedValue([]);
    tasksApiMock.listLabels.mockResolvedValue([]);
    authApiMock.getSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { userId: "user-1" },
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  it("sends a search request when ?q is in the URL and renders the result", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "auth flake",
      normalizedQuery: "auth flake",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 1,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [
        {
          id: AUTH_TASK_ID,
          type: "task",
          score: 100,
          title: "PAP-3142 Auth middleware flakes",
          routeTarget: { kind: "task", taskNumber: 3142, hash: null },
          matchedFields: ["title", "comment"],
          sourceLabel: "Comment",
          snippet: "we hit another flake",
          snippets: [
            {
              field: "title",
              label: "Title",
              text: "Auth middleware flakes",
              highlights: [{ start: 0, end: 4 }],
            },
            {
              field: "comment",
              label: "Comment",
              text: "we hit another flake in the morning batch",
              highlights: [{ start: 16, end: 21 }],
            },
          ],
          task: {
            id: AUTH_TASK_ID,
            taskNumber: 3142,
            identifier: "PAP-3142",
            title: "Auth middleware flakes",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            request:
              "Investigate intermittent authentication middleware failures.",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
      ],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth+flake",
      container,
    );

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "auth flake",
          scope: "all",
          limit: 20,
        },
      );
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("PAP-3142");
      expect(container.textContent).toContain("Auth middleware flakes");
      expect(container.textContent).toContain("1 result");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders artifact search results in the company search surface", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "launch brief",
      normalizedQuery: "launch brief",
      scope: "artifacts",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 1,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [
        {
          id: "document:artifact-1",
          type: "artifact",
          score: 140,
          title: "Launch Artifact Brief",
          routeTarget: { kind: "task", taskNumber: 42, hash: "document-brief" },
          matchedFields: ["artifact"],
          sourceLabel: "Artifact",
          snippet: "launch brief preview text",
          snippets: [
            {
              field: "artifact",
              label: "Artifact",
              text: "launch brief preview text",
              highlights: [{ start: 0, end: 6 }],
            },
          ],
          artifact: {
            id: "document:artifact-1",
            source: "document",
            mediaKind: "document",
            taskId: ARTIFACT_TASK_ID,
            taskNumber: 42,
            taskIdentifier: "PAP-42",
            taskTitle: "Ship launch artifacts",
            taskFragment: "document-brief",
            projectId: null,
            projectName: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
      ],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=launch+brief&scope=artifacts",
      container,
    );

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "launch brief",
          scope: "artifacts",
          limit: 20,
        },
      );
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Launch Artifact Brief");
      expect(container.textContent).toContain("PAP-42");
      expect(container.textContent).toContain("launch brief preview text");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders comment and document result rows with exact anchors, source chips, and highlights", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "needle",
      normalizedQuery: "needle",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 1,
        document: 1,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [
        {
          id: "task-comment",
          type: "task",
          score: 180,
          title: "PAP-77 Comment source",
          routeTarget: {
            kind: "task",
            taskNumber: 77,
            hash: "comment-comment-77",
          },
          matchedFields: ["comment"],
          sourceLabel: "Comment",
          snippet: "thread needle evidence",
          snippets: [
            {
              field: "comment",
              label: "Comment",
              text: "thread needle evidence",
              highlights: [{ start: 7, end: 13 }],
            },
          ],
          task: {
            id: "task-comment",
            taskNumber: 77,
            identifier: "PAP-77",
            title: "Comment source",
            boardPresentationStatus: "todo",
            priority: "medium",
            request: "Review the comment source result.",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
        {
          id: "task-document",
          type: "task",
          score: 170,
          title: "PAP-78 Document source",
          routeTarget: { kind: "task", taskNumber: 78, hash: "document-plan" },
          matchedFields: ["document"],
          sourceLabel: "Plan",
          snippet: "plan needle evidence",
          snippets: [
            {
              field: "document",
              label: "Plan",
              text: "plan needle evidence",
              highlights: [{ start: 5, end: 11 }],
            },
          ],
          task: {
            id: "task-document",
            taskNumber: 78,
            identifier: "PAP-78",
            title: "Document source",
            boardPresentationStatus: "todo",
            priority: "medium",
            request: "Review the document source result.",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
      ],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=needle",
      container,
    );

    await waitForAssertion(() => {
      expect(
        container.querySelector(
          'a[href="/11111111-1111-4111-8111-111111111111/tasks/77#comment-comment-77"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          'a[href="/11111111-1111-4111-8111-111111111111/tasks/78#document-plan"]',
        ),
      ).not.toBeNull();
      expect(container.textContent).toContain("Comment");
      expect(container.textContent).toContain("Doc");
      expect(container.querySelectorAll("mark")).toHaveLength(2);
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders the explicit loading state while search is pending", async () => {
    searchApiMock.search.mockReturnValueOnce(new Promise(() => {}));

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=slow",
      container,
    );

    await waitForAssertion(() => {
      expect(
        container.querySelector('[data-testid="search-loading"]')?.textContent,
      ).toContain("slow");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders the explicit error state with retry and fallback actions", async () => {
    searchApiMock.search.mockRejectedValueOnce(
      Object.assign(new Error("Search failed"), { status: 500 }),
    );

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=broken",
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Couldn’t run that search");
      expect(container.textContent).toContain("The server returned 500.");
      expect(container.textContent).toContain("Retry");
      expect(container.textContent).toContain("Open Tasks filter view");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("debounces typing into the input and dispatches a search after the debounce window", async () => {
    searchApiMock.search.mockResolvedValue({
      query: "deflake",
      normalizedQuery: "deflake",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search",
      container,
    );

    const input = await getSearchInput(container);

    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "deflake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The debounce hasn't fired yet, so no API call should be made synchronously.
    expect(searchApiMock.search).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 350));

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "deflake",
          scope: "all",
          limit: 20,
        },
      );
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("keeps exact identifier searches on the results page", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "PAP-3366",
      normalizedQuery: "pap-3366",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 1,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [
        {
          id: CONTINUATION_TASK_ID,
          type: "task",
          score: 1300,
          title: "PAP-3366 Continuation summary",
          routeTarget: {
            kind: "task",
            taskNumber: 3366,
            hash: "document-run-summary",
          },
          matchedFields: ["identifier", "document"],
          sourceLabel: "Document",
          snippet: "Continuation summary excerpt",
          snippets: [
            {
              field: "document",
              label: "Continuation summary",
              text: "Continuation summary excerpt",
              highlights: [],
            },
          ],
          task: {
            id: CONTINUATION_TASK_ID,
            taskNumber: 3366,
            identifier: "PAP-3366",
            title: "Continuation summary",
            boardPresentationStatus: "in_progress",
            priority: "medium",
            request: "Continue from the recorded run summary.",
            ownerAgentId: null,
            ownerUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
          previewImageUrl: null,
        },
      ],
    });

    const { root, routerRef } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=PAP-3366",
      container,
    );

    await waitForAssertion(() => {
      expect(routerRef.current?.state.location.pathname).toBe(
        "/11111111-1111-4111-8111-111111111111/search",
      );
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders the no-results state with a Search-all action when scope is non-default", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "ghost",
      normalizedQuery: "ghost",
      scope: "comments",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=ghost&scope=comments",
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("No results for");
      expect(container.textContent).toContain("ghost");
      expect(container.textContent).toContain("Search all scopes");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("parses URL filters into search params and operator pills", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "auth",
      normalizedQuery: "auth",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&status=todo&updatedWithin=7d",
      container,
    );

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "auth",
          scope: "all",
          limit: 20,
          status: ["todo"],
          updatedWithin: "7d",
        },
      );
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("status:todo");
      expect(container.textContent).toContain("updated:>7d");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("parses typed operators before dispatching search", async () => {
    searchApiMock.search.mockResolvedValue({
      query: "auth",
      normalizedQuery: "auth",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search",
      container,
    );
    const input = await getSearchInput(container);

    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "auth status:blocked");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "auth",
          scope: "all",
          limit: 20,
          status: ["blocked"],
        },
      );
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("status:blocked");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("drops a committed operator filter from requests when its token is deleted", async () => {
    searchApiMock.search.mockResolvedValue(emptyResponse());

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search",
      container,
    );
    const input = await getSearchInput(container);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    flushSync(() => {
      nativeSetter.call(input, "auth status:blocked");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "auth",
          scope: "all",
          limit: 20,
          status: ["blocked"],
        },
      );
    });

    // Deleting the operator token must also delete its filter from the request.
    flushSync(() => {
      nativeSetter.call(input, "auth");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForAssertion(() => {
      const lastCall = searchApiMock.search.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({
        q: "auth",
        scope: "all",
        limit: 20,
      });
      expect(lastCall?.[1]).not.toHaveProperty("status");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("removes an operator-derived filter chip and strips its token from the query", async () => {
    searchApiMock.search.mockResolvedValue(emptyResponse());

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search",
      container,
    );
    const input = await getSearchInput(container);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    flushSync(() => {
      nativeSetter.call(input, "auth status:blocked");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await new Promise((resolve) => setTimeout(resolve, 350));
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "auth",
          scope: "all",
          limit: 20,
          status: ["blocked"],
        },
      );
    });

    const removeButton = await (async () => {
      let button: HTMLButtonElement | null = null;
      await waitForAssertion(() => {
        button = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove filter Status: Blocked"]',
        );
        expect(button).not.toBeNull();
      });
      return button!;
    })();

    flushSync(() => {
      removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The chip removal wins over the typed token: the input keeps only the plain
    // text and the re-query carries no status filter.
    await waitForAssertion(() => {
      expect(input.value).toBe("auth");
      const lastCall = searchApiMock.search.mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual({ q: "auth", scope: "all", limit: 20 });
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("shows operator autocomplete suggestions and applies one to the current token", async () => {
    searchApiMock.search.mockResolvedValue({
      query: "auth",
      normalizedQuery: "auth",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [],
    });

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search",
      container,
    );
    const input = await getSearchInput(container);

    flushSync(() => {
      input.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "auth sta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    let suggestionButton: HTMLButtonElement | null = null;
    await waitForAssertion(() => {
      const suggestions = container.querySelector(
        '[data-testid="search-operator-suggestions"]',
      );
      expect(suggestions).not.toBeNull();
      expect(suggestions!.textContent).toContain("status:todo");
      expect(suggestions!.textContent).toContain("status:blocked");
      expect(suggestions!.textContent).not.toContain("assignee:me");
      suggestionButton = container.querySelector(
        'button[aria-label="Insert operator status:todo"]',
      );
      expect(suggestionButton).not.toBeNull();
    });

    flushSync(() => {
      suggestionButton!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
      suggestionButton!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    await waitForAssertion(() => {
      expect(input.value).toBe("auth status:todo");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  function emptyResponse(overrides: Record<string, unknown> = {}) {
    return {
      query: "auth",
      normalizedQuery: "auth",
      scope: "all",
      limit: 20,
      offset: 0,
      sort: "relevance",
      countsByType: {
        task: 0,
        comment: 0,
        document: 0,
        artifact: 0,
        agent: 0,
        project: 0,
      },
      filterOptionCounts: {
        status: {},
        priority: {},
        ownerAgentId: {},
        ownerUserId: {},
        projectId: {},
        labelId: {},
        updatedWithin: {},
      },
      zeroResults: null,
      hasMore: false,
      results: [],
      ...overrides,
    };
  }

  it("round-trips the sort param through the URL and into the search request", async () => {
    searchApiMock.search.mockResolvedValue(emptyResponse({ sort: "updated" }));

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&sort=updated",
      container,
    );

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "auth",
          scope: "all",
          limit: 20,
          sort: "updated",
        },
      );
    });

    await waitForAssertion(() => {
      // The Sort menu trigger reflects the active sort.
      expect(container.textContent).toContain("Recently updated");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders a removable filter chip and re-queries without the filter when removed", async () => {
    searchApiMock.search.mockResolvedValue(emptyResponse());

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&status=todo",
      container,
    );

    // First request carries the status filter from the URL.
    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith(
        "11111111-1111-4111-8111-111111111111",
        {
          q: "auth",
          scope: "all",
          limit: 20,
          status: ["todo"],
        },
      );
    });

    // A removable chip is rendered for the active filter.
    const removeButton = await (async () => {
      let button: HTMLButtonElement | null = null;
      await waitForAssertion(() => {
        button = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove filter Status: Todo"]',
        );
        expect(button).not.toBeNull();
      });
      return button!;
    })();

    flushSync(() => {
      removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // After removal the search re-fires with no status filter.
    await waitForAssertion(() => {
      const lastCall = searchApiMock.search.mock.calls.at(-1);
      expect(lastCall?.[1]).toEqual({ q: "auth", scope: "all", limit: 20 });
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders zero-results recovery with loosen suggestions when filters empty the page", async () => {
    searchApiMock.search.mockResolvedValueOnce(
      emptyResponse({
        zeroResults: {
          unfilteredTotal: 12,
          loosenSuggestions: [
            {
              filter: "status",
              values: ["done"],
              resultCount: 12,
              additionalCount: 12,
            },
          ],
        },
      }),
    );

    const { root } = renderSearch(
      "/11111111-1111-4111-8111-111111111111/search?q=auth&status=done",
      container,
    );

    await waitForAssertion(() => {
      expect(
        container.querySelector('[data-testid="search-zero-results-recovery"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain("No results with these filters");
      expect(container.textContent).toContain("12 results match");
      expect(container.textContent).toContain("Loosen a filter");
      expect(container.textContent).toContain("+12 results");
      expect(container.textContent).toContain("Clear all filters");
    });

    flushSync(() => {
      root.unmount();
    });
  });
});
