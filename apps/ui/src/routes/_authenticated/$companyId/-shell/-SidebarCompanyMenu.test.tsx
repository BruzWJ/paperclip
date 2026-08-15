// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarCompanyMenu } from "./-SidebarCompanyMenu";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  signOut: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenOnboarding = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockSidebarPreferencesApi = vi.hoisted(() => ({
  getCompanyOrder: vi.fn(),
  updateCompanyOrder: vi.fn(),
}));
const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
const STRATA_COMPANY_ID = vi.hoisted(() => "22222222-2222-4222-8222-222222222222");
const ANACHRONIST_COMPANY_ID = vi.hoisted(() => "33333333-3333-4333-8333-333333333333");

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/sidebarPreferences", () => ({
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={to.replace("$companyId", params?.companyId ?? "")} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => mockNavigate,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: COMPANY_ID,
        taskPrefix: "PAP",
        name: "Acme Labs",
        brandColor: "#3366ff",
        status: "active",
      },
      {
        id: STRATA_COMPANY_ID,
        taskPrefix: "STR",
        name: "Strata",
        brandColor: "#36a269",
        status: "active",
      },
      {
        id: ANACHRONIST_COMPANY_ID,
        taskPrefix: "ANA",
        name: "Anachronist Wiki",
        brandColor: "#a36a21",
        status: "active",
      },
    ],
    selectedCompany: {
      id: COMPANY_ID,
      taskPrefix: "PAP",
      name: "Acme Labs",
      brandColor: "#3366ff",
      status: "active",
    },
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialogActions: () => ({
    openOnboarding: mockOpenOnboarding,
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("SidebarCompanyMenu", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
      },
    });
    mockAuthApi.signOut.mockResolvedValue(undefined);
    mockSidebarPreferencesApi.getCompanyOrder.mockResolvedValue({
      orderedIds: [COMPANY_ID, STRATA_COMPANY_ID, ANACHRONIST_COMPANY_ID],
      updatedAt: null,
    });
    mockSidebarPreferencesApi.updateCompanyOrder.mockResolvedValue({
      orderedIds: [COMPANY_ID, STRATA_COMPANY_ID, ANACHRONIST_COMPANY_ID],
      updatedAt: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uses company-centric create copy without the chat flag", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Create new company...");
    expect(document.body.textContent).not.toContain("Add company...");

    act(() => {
      root.unmount();
    });
  });

  it("shows the requested company actions and signs out through the dropdown", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Acme Labs");

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Switch company");
    expect(document.body.textContent).toContain("Edit");
    expect(document.body.textContent).toContain("Strata");
    expect(document.body.textContent).toContain("ANA");
    expect(document.body.textContent).toContain("Create new company...");
    expect(document.body.textContent).toContain("Invite people to Acme Labs");
    expect(document.body.textContent).toContain("Company settings");
    expect(document.body.textContent).toContain("Sign out");

    const signOutButton = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]')).find(
      (element) => element.textContent?.includes("Sign out"),
    );
    expect(signOutButton).toBeTruthy();

    act(() => {
      signOutButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAuthApi.signOut).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("toggles company order editing without selecting a company", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const editButton = Array.from(document.body.querySelectorAll("button")).find(
      (element) => element.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    act(() => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Done");
    expect(document.body.textContent).not.toContain("PAP");
    expect(document.body.textContent).not.toContain("ANA");
    const strataItem = Array.from(document.body.querySelectorAll('[role="button"]')).find((element) =>
      element.textContent?.includes("Reorder Strata"),
    );
    expect(strataItem).toBeTruthy();

    act(() => {
      strataItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockNavigate).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("navigates to the selected company dashboard from the authenticated company route", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarCompanyMenu />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const trigger = container.querySelector('button[aria-label="Open Acme Labs company switcher"]');
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const strataItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]')).find(
      (element) => element.textContent?.includes("Strata"),
    );
    expect(strataItem).toBeTruthy();

    act(() => {
      strataItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/$companyId/dashboard",
      params: { companyId: STRATA_COMPANY_ID },
    });

    act(() => {
      root.unmount();
    });
  });
});
