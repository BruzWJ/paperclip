// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from ".";
import { getRouteComponent } from "@/test/route-component";

const CompanyAccess = getRouteComponent(Route);

const listMembersMock = vi.hoisted(() => vi.fn());
const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const updateMemberMock = vi.hoisted(() => vi.fn());
const archiveMemberMock = vi.hoisted(() => vi.fn());
const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (companyId: string) => listMembersMock(companyId),
    listJoinRequests: (companyId: string, status: string) =>
      listJoinRequestsMock(companyId, status),
    updateMember: (companyId: string, memberId: string, input: unknown) =>
      updateMemberMock(companyId, memberId, input),
    archiveMember: (companyId: string, memberId: string) =>
      archiveMemberMock(companyId, memberId),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: COMPANY_ID, name: "Paperclip" },
  }),
}));

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyAccess", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listMembersMock.mockResolvedValue({
      members: [
        {
          id: "member-1",
          companyId: COMPANY_ID,
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-1",
            email: "codexcoder@paperclip.local",
            name: "Codex Coder",
            image: null,
          },
          grants: [],
        },
        {
          id: "member-2",
          companyId: COMPANY_ID,
          principalType: "user",
          principalId: "user-2",
          status: "active",
          membershipRole: "operator",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-2",
            email: "board@paperclip.local",
            name: "Board User",
            image: null,
          },
          grants: [],
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    listJoinRequestsMock.mockResolvedValue([
      {
        id: "join-1",
        createdAt: "2026-04-10T00:00:00.000Z",
        requesterUser: {
          id: "user-2",
          email: "board@paperclip.local",
          name: "Board User",
          image: null,
        },
        requestEmailSnapshot: "board@paperclip.local",
        requestingUserId: "user-2",
        invite: {
          userRole: "operator",
        },
      },
    ]);
    updateMemberMock.mockResolvedValue({});
    archiveMemberMock.mockResolvedValue({ archived: true });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps the page human-focused and hides advanced permission controls", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain(
      "Manage the people who can work in Paperclip",
    );
    expect(container.textContent).toContain(
      "Members can collaborate across the company by default",
    );
    expect(container.textContent).toContain(
      "Core keeps this page focused on membership",
    );
    expect(container.textContent).toContain("Humans");
    expect(container.textContent).toContain("Pending human joins");
    expect(container.textContent).toContain("User account");
    expect(container.textContent).not.toContain("Grants");
    expect(container.textContent).not.toContain("explicit grants");
    expect(container.textContent).not.toContain("Assign scoped tasks");
    expect(container.textContent).not.toContain("Agents");
    expect(container.textContent).not.toContain("Open join request queue");
    expect(container.textContent).not.toContain("Manage invites");
    expect(container.textContent).not.toContain("Active user accounts");
    expect(container.textContent).not.toContain("Suspended user accounts");
    expect(container.textContent).not.toContain("Pending user joins");

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain(
      "Update company role and membership status",
    );
    expect(document.body.textContent).not.toContain(
      "Implicit grants from role",
    );
    expect(document.body.textContent).not.toContain("permissionKey");

    await act(async () => {
      root.unmount();
    });
  });

  it("saves member role and status without touching grants", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const saveButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((button) => button.textContent === "Save member");
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateMemberMock).toHaveBeenCalledWith(COMPANY_ID, "member-1", {
      membershipRole: "owner",
      status: "active",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("archives a member without an assignment cleanup flow", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const removeButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((button) => button.textContent?.includes("Remove"));
    expect(removeButtons.length).toBeGreaterThan(0);

    await act(async () => {
      removeButtons[0]?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushReact();

    expect(document.body.textContent).toContain("Remove member");
    expect(document.body.textContent).toContain(
      "Archive Codex Coder and revoke their company access",
    );
    expect(document.body.querySelector("select")).toBeNull();

    const confirmButton = Array.from(
      document.body.querySelectorAll("button"),
    ).find((button) => button.textContent === "Remove member");
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveMemberMock).toHaveBeenCalledExactlyOnceWith(
      COMPANY_ID,
      "member-1",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("shows protected member removal reasons from the API", async () => {
    listMembersMock.mockResolvedValueOnce({
      members: [
        {
          id: "member-admin",
          companyId: COMPANY_ID,
          principalType: "user",
          principalId: "admin-user",
          status: "active",
          membershipRole: "admin",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "admin-user",
            email: "admin@paperclip.local",
            name: "Admin User",
            image: null,
          },
          grants: [],
          removal: {
            canArchive: false,
            reason: "Company admins cannot be removed from company access.",
          },
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: false,
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain(
      "Company admins cannot be removed from company access.",
    );
    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Remove"),
    );
    expect(removeButton).toBeTruthy();
    expect(removeButton).toHaveProperty("disabled", true);

    await act(async () => {
      root.unmount();
    });
  });
});
