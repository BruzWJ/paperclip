// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

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

describe("Sidebar Goals navigation", () => {
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

  it("always renders Goals in Work without loading an optional setting", () => {
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

    const links = [...container.querySelectorAll("nav a")];
    const goals = links.find((link) => link.textContent?.trim() === "Goals");
    const artifacts = links.find((link) => link.textContent?.trim() === "Artifacts");

    expect(goals?.getAttribute("href")).toBe("/goals");
    expect(links.indexOf(goals!)).toBeLessThan(links.indexOf(artifacts!));
  });
});
