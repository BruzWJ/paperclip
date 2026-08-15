// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedAppGate } from "./-AuthenticatedAppGate";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
  claimBootstrapAdmin: vi.fn(),
}));

const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");

vi.mock("@/api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Navigate: ({ to, search }: { to: string; search?: { next?: string } }) => <div>Navigate:{to}:{search?.next}</div>,
  Outlet: () => <div>Outlet content</div>,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({
      location: {
        pathname: "/auth",
        searchStr: `?next=/${COMPANY_ID}/company/settings/instance`,
      },
      resolvedLocation: {
        pathname: `/${COMPANY_ID}/company/settings/instance`,
        searchStr: "",
      },
    }),
}));

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await flushReact();
  }
  expect(container.textContent).toContain(text);
}

function renderGate(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AuthenticatedAppGate />
      </QueryClientProvider>,
    );
  });

  return root;
}

function unmountRoot(root: ReturnType<typeof createRoot>) {
  flushSync(() => {
    root.unmount();
  });
}

describe("AuthenticatedAppGate", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentExposure: "private",
      bootstrapStatus: "ready",
    });
    mockAuthApi.signOut.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("redirects signed-out users to authentication when bootstrap is ready", async () => {
    mockAuthApi.getSession.mockResolvedValue(null);

    const root = renderGate(container);
    await waitForText(container, "Navigate:/auth");

    expect(container.textContent).toContain("Navigate:/auth");
    expect(container.textContent).toContain(`Navigate:/auth:/${COMPANY_ID}/company/settings/instance`);
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();

    unmountRoot(root);
  });

  it("shows a no-access message for signed-in users without org access", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = renderGate(container);
    await waitForText(container, "No company access");

    expect(container.textContent).toContain("No company access");
    expect(container.textContent).toContain("Switch account");
    expect(container.textContent).not.toContain("Outlet content");

    unmountRoot(root);
  });

  it("lets a signed-in user without company access switch accounts", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = renderGate(container);
    await waitForText(container, "Switch account");

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Switch account"),
    );
    expect(button).toBeTruthy();
    flushSync(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForText(container, "Switch account");

    expect(mockAuthApi.signOut).toHaveBeenCalledTimes(1);

    unmountRoot(root);
  });

  it("allows authenticated users with company access through to the board", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [COMPANY_ID],
      source: "session",
      keyId: null,
    });

    const root = renderGate(container);
    await waitForText(container, "Outlet content");

    expect(container.textContent).toContain("Outlet content");
    expect(container.textContent).not.toContain("No company access");

    unmountRoot(root);
  });

  it("shows browser sign-in setup for signed-out private bootstrap-pending instances", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentExposure: "private",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
    });
    mockAuthApi.getSession.mockResolvedValue(null);

    const root = renderGate(container);
    await waitForText(container, "Finish setting up this Paperclip");

    expect(container.textContent).toContain("Finish setting up this Paperclip");
    expect(container.textContent).toContain("Sign in / Create account");
    expect(container.textContent).toContain("pnpm paperclipai auth bootstrap-admin");
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();

    unmountRoot(root);
  });

  it("shows the claim action for signed-in private bootstrap-pending instances", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentExposure: "private",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
    });
    mockAccessApi.claimBootstrapAdmin.mockResolvedValue({
      claimed: true,
      userId: "user-1",
    });

    const root = renderGate(container);
    await waitForText(container, "Claim this instance");

    expect(container.textContent).toContain("Claim this instance");
    expect(container.textContent).toContain("Signed in as user@example.com");
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Claim this instance"),
    );
    expect(button).toBeTruthy();
    flushSync(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForText(container, "You're the instance admin");

    expect(mockAccessApi.claimBootstrapAdmin).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("You're the instance admin");
    expect(container.textContent).toContain("Continue to dashboard");

    unmountRoot(root);
  });

  it("keeps public bootstrap-pending instances invite-only", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentExposure: "public",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: true,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "User",
        image: null,
      },
    });

    const root = renderGate(container);
    await waitForText(container, "This Paperclip is waiting on its first admin");

    expect(container.textContent).toContain("This Paperclip is waiting on its first admin");
    expect(container.textContent).toContain("invite-only mode");
    expect(container.textContent).not.toContain("Claim this instance");
    expect(container.textContent).not.toContain("Sign in / Create account");
    expect(mockAccessApi.claimBootstrapAdmin).not.toHaveBeenCalled();

    unmountRoot(root);
  });
});
