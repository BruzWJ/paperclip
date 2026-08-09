// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const mockAttentionList = vi.hoisted(() => vi.fn());

vi.mock("../api/attention", () => ({
  attentionApi: { list: mockAttentionList },
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" },
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    collapsed: false,
    collapseLocked: false,
    peeking: false,
    toggleCollapsed: vi.fn(),
    setCollapsed: vi.fn(),
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("../hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({
    enabled: false,
    refetchInterval: false,
    isLeader: false,
    publish: vi.fn(),
  }),
  usePublishSharedQueryData: () => undefined,
}));

vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
vi.mock("./SidebarAgents", () => ({ SidebarAgents: () => null }));
vi.mock("./SidebarStarredProjects", () => ({ SidebarStarredProjects: () => null }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => <div>Company</div> }));

describe("Sidebar Decisions navigation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderWithItems(items: Array<{ sourceKind: string }>) {
    mockAttentionList.mockResolvedValue({ items });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(mockAttentionList).toHaveBeenCalledWith("company-1"));
  }

  it("shows Decisions for a canonical Board mention without any feature setting", async () => {
    await renderWithItems([{ sourceKind: "mention_board" }]);
    await vi.waitFor(() => {
      expect(container.querySelector('a[href="/decisions"]')?.textContent).toContain("Decisions");
    });
  });

  it("keeps Decisions hidden when the attention feed has no Board mention", async () => {
    await renderWithItems([{ sourceKind: "approval" }]);
    expect(container.querySelector('a[href="/decisions"]')).toBeNull();
  });
});
