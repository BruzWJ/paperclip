// @vitest-environment jsdom

import { TestRouter } from "@/test/TestRouter";
import { getRouteComponent } from "@/test/route-component";
import type { CompanySearchResponse } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import { Route } from ".";

export const Search = getRouteComponent(Route);

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

export const AUTH_TASK_ID = "44444444-4444-4444-8444-444444444444";
export const ARTIFACT_TASK_ID = "55555555-5555-4555-8555-555555555555";
export const CONTINUATION_TASK_ID = "66666666-6666-4666-8666-666666666666";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function waitForAssertion(assertion: () => void, attempts = 50) {
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

export async function getSearchInput(container: HTMLElement): Promise<HTMLInputElement> {
  let input: HTMLInputElement | null = null;
  await waitForAssertion(() => {
    input = container.querySelector<HTMLInputElement>('input[aria-label="Search query"]');
    expect(input).not.toBeNull();
  });
  return input!;
}

export function renderSearch(initialPath: string, container: HTMLDivElement, node?: ReactNode) {
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

export function emptySearchResponse(overrides: Partial<CompanySearchResponse> = {}): CompanySearchResponse {
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

export function setupSearchPageTest() {
  const container = document.createElement("div");
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
  return {
    container,
    cleanup: () => container.remove(),
  };
}

export function useBreadcrumbStateTestState() {
  return breadcrumbState;
}

export function useDialogStateTestState() {
  return dialogState;
}

export function useSearchApiMockTestState() {
  return searchApiMock;
}

export function useAgentsApiMockTestState() {
  return agentsApiMock;
}

export function useProjectsApiMockTestState() {
  return projectsApiMock;
}

export function useTasksApiMockTestState() {
  return tasksApiMock;
}

export function useAuthApiMockTestState() {
  return authApiMock;
}
