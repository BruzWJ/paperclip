// @vitest-environment jsdom

import type { AttentionItem } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, vi } from "vitest";

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => "11111111-1111-4111-8111-111111111111",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    hash,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    params?: Record<string, string>;
    hash?: string;
  }) => {
    const pathname = Object.entries(params ?? {}).reduce(
      (path, [key, value]) => path.replace(`$${key}`, value),
      to,
    );
    return (
      <a href={`${pathname}${hash ? `#${hash}` : ""}`} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
  },
}));

// Spy on `relativeTime` (called exactly once per active-row render) so the
// memoization test below can count row renders without a profiling build.
vi.mock("../lib/utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/utils")>();
  return { ...original, relativeTime: vi.fn(original.relativeTime) };
});

const { approvalsApi } = await import("../api/approvals");
const { AttentionQueueRow } = await import("./AttentionQueueRow");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export function act<T>(cb: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = cb();
  });
  return result as T;
}

export let root: ReturnType<typeof createRoot> | null = null;
export let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

export function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  return container;
}

export function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: {
      kind: "approval",
      id: "approval-1",
      companyId: "c1",
      title: "Hire agent: Research Analyst",
      taskNumber: null,
      identifier: null,
      status: "pending",
      routeTarget: {
        kind: "approval",
        id: "22222222-2222-4222-8222-222222222222",
      },
      metadata: {},
    },
    whyNow: "Approval is pending a board decision.",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "approval:approval-1",
    dismissalKey: "attention:approval:approval-1",
    severity: "high",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedTask: null,
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    ...overrides,
  };
}

export const noop = () => {};

export { approvalsApi, AttentionQueueRow };
