// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./-Sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

const mockAttentionList = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({
  collapsed: false,
  peeking: false,
}));
const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");

vi.mock("@/api/attention", () => ({
  attentionApi: { list: mockAttentionList },
}));

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    activeProps: _activeProps,
    inactiveProps: _inactiveProps,
    activeOptions: _activeOptions,
    state: _state,
    ...props
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
    activeProps?: unknown;
    inactiveProps?: unknown;
    activeOptions?: unknown;
    state?: unknown;
  }) => (
    <a href={to.replace("$companyId", params?.companyId ?? "")} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({ openNewTask: vi.fn() }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: COMPANY_ID, taskPrefix: "PAP", name: "Paperclip" },
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    collapseLocked: false,
    ...mockSidebarState,
    toggleCollapsed: vi.fn(),
    setCollapsed: vi.fn(),
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("@/hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));
vi.mock("./-SidebarAgents", () => ({ SidebarAgents: () => null }));
vi.mock("./-SidebarStarredProjects", () => ({
  SidebarStarredProjects: () => null,
}));
vi.mock("./-SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company</div>,
}));

describe("Sidebar Decisions navigation", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockSidebarState.collapsed = false;
    mockSidebarState.peeking = false;
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
          <SidebarProvider>
            <Sidebar />
          </SidebarProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(mockAttentionList).toHaveBeenCalledWith(COMPANY_ID));
  }

  it("shows Decisions for a canonical Board mention without any feature setting", async () => {
    await renderWithItems([{ sourceKind: "mention_board" }]);
    await vi.waitFor(() => {
      expect(container.querySelector(`a[href="/${COMPANY_ID}/decisions"]`)?.textContent).toContain(
        "Decisions",
      );
    });
  });

  it("keeps Decisions hidden when the attention feed has no Board mention", async () => {
    await renderWithItems([{ sourceKind: "approval" }]);
    expect(container.querySelector(`a[href="/${COMPANY_ID}/decisions"]`)).toBeNull();
  });

  it("keeps the navigation skeleton fixed between expanded and rail states", async () => {
    await renderWithItems([]);

    const expandedNavClass = container.querySelector("nav")?.getAttribute("class");
    const expandedTopGroupClass = container
      .querySelector("nav > [data-sidebar=\"group\"]")
      ?.getAttribute("class");

    mockSidebarState.collapsed = true;
    await renderWithItems([]);

    expect(container.querySelector("nav")?.getAttribute("class")).toBe(expandedNavClass);
    expect(container.querySelector("nav > [data-sidebar=\"group\"]")?.getAttribute("class")).toBe(
      expandedTopGroupClass,
    );
    expect(expandedNavClass).toContain("gap-4");
    expect(expandedTopGroupClass).toContain("p-3");
    expect(expandedTopGroupClass).toContain("py-2");
  });
});
