// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from ".";
import { queryKeys } from "@/lib/queryKeys";
import { TestRouter } from "@/test/TestRouter";
import { getRouteComponent } from "@/test/route-component";

const CompanyInvites = getRouteComponent(Route);

const listInvitesMock = vi.hoisted(() => vi.fn());
const createCompanyInviteMock = vi.hoisted(() => vi.fn());
const revokeInviteMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const clipboardWriteTextMock = vi.hoisted(() => vi.fn());
const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");

vi.mock("@/api/access", () => ({
  accessApi: {
    listInvites: (companyId: string, options?: unknown) =>
      listInvitesMock(companyId, options),
    createCompanyInvite: (companyId: string, input: unknown) =>
      createCompanyInviteMock(companyId, input),
    revokeInvite: (inviteId: string) => revokeInviteMock(inviteId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: COMPANY_ID, name: "Paperclip", taskPrefix: "PAP" },
  }),
  useOptionalCompany: () => ({
    selectedCompany: { id: COMPANY_ID, name: "Paperclip", taskPrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyInvites", () => {
  let container: HTMLDivElement;
  const inviteHistory = Array.from({ length: 25 }, (_, index) => {
    const inviteNumber = 25 - index;
    const isActive = inviteNumber === 25;
    return {
      id: `invite-${inviteNumber}`,
      companyId: COMPANY_ID,
      inviteType: "company_join",
      tokenHash: `hash-${inviteNumber}`,
      defaultsPayload: null,
      expiresAt: "2026-04-20T00:00:00.000Z",
      invitedByUserId: "user-1",
      revokedAt: null,
      acceptedAt: isActive ? null : "2026-04-11T00:00:00.000Z",
      createdAt: `2026-04-${String(inviteNumber).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: `2026-04-${String(inviteNumber).padStart(2, "0")}T00:00:00.000Z`,
      companyName: "Paperclip",
      userRole: isActive ? "operator" : "viewer",
      state: isActive ? "active" : "accepted",
      invitedByUser: {
        id: "user-1",
        name: `Board User ${inviteNumber}`,
        email: `board${inviteNumber}@paperclip.local`,
        image: null,
      },
      relatedJoinRequestId: isActive ? "join-1" : null,
    };
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    listInvitesMock.mockImplementation(
      (_companyId: string, options?: { limit?: number; offset?: number }) => {
        const limit = options?.limit ?? 20;
        const offset = options?.offset ?? 0;
        const invites = inviteHistory.slice(offset, offset + limit);
        const nextOffset =
          offset + invites.length < inviteHistory.length
            ? offset + invites.length
            : null;
        return Promise.resolve({ invites, nextOffset });
      },
    );

    createCompanyInviteMock.mockImplementation(() => {
      return Promise.resolve({
        token: "new-token",
        inviteUrl: "https://paperclip.local/invite/new-token",
        userRole: "viewer",
      });
    });

    revokeInviteMock.mockResolvedValue(undefined);

    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a human-only invite flow and keeps invite history in a table", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[`/${COMPANY_ID}/company/settings/invites`]}
        >
          <QueryClientProvider client={queryClient}>
            <CompanyInvites />
          </QueryClientProvider>
        </TestRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company Invites");
    expect(container.textContent).toContain("Invite a person");
    expect(container.textContent).toContain("Invite history");
    expect(container.textContent).toContain("Board User 25");
    expect(container.textContent).toContain("Board User 21");
    expect(container.textContent).not.toContain("Board User 20");
    expect(container.textContent).toContain("Review request");
    expect(container.textContent).toContain("View more");
    expect(container.textContent).not.toContain("Invite message");
    expect(container.textContent).not.toContain("Latest generated invite");
    expect(container.textContent).not.toContain("Active invites");
    expect(container.textContent).not.toContain("Consumed invites");
    expect(container.textContent).not.toContain("Expired invites");
    expect(container.textContent).not.toContain("OpenClaw shortcut");

    expect(container.textContent).toContain("Choose a role");
    expect(container.textContent).toContain("Each invite link is single-use.");
    expect(container.textContent).toContain(
      "Can create agents, invite users, assign tasks, and approve join requests.",
    );
    expect(container.textContent).toContain(
      "Everything in Admin, plus managing members.",
    );
    expect(container.textContent).not.toContain("permission grants");
    expect(listInvitesMock).toHaveBeenCalledWith(COMPANY_ID, {
      limit: 5,
      offset: 0,
    });

    const viewMoreButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "View more");

    await act(async () => {
      viewMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(listInvitesMock).toHaveBeenCalledWith(COMPANY_ID, {
      limit: 5,
      offset: 5,
    });
    expect(container.textContent).toContain("Board User 20");
    expect(container.textContent).toContain("Board User 16");
    expect(container.textContent).toContain("View more");

    await act(async () => {
      const viewerRadio = container.querySelector(
        'input[type="radio"][value="viewer"]',
      ) as HTMLInputElement | null;
      viewerRadio?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      viewerRadio?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const createButton = buttons.find(
      (button) => button.textContent === "Create invite",
    );
    const revokeButton = buttons.find(
      (button) => button.textContent === "Revoke",
    );

    expect(createButton).toBeTruthy();
    expect(revokeButton).toBeTruthy();

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(createCompanyInviteMock).toHaveBeenCalledWith(COMPANY_ID, {
      userRole: "viewer",
    });
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "https://paperclip.local/invite/new-token",
    );
    expect(container.textContent).toContain("Latest invite link");
    expect(container.textContent).toContain(
      "This URL includes the current Paperclip domain returned by the server.",
    );
    expect(
      container.querySelector('input[aria-label="Latest invite URL"]'),
    ).toHaveProperty("value", "https://paperclip.local/invite/new-token");
    expect(container.textContent).toContain("Copy link");
    expect(container.textContent).toContain("Open invite");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Invite created",
      body: "Invite ready below and copied to clipboard.",
      tone: "success",
    });

    const copyLinkButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Copy link");

    await act(async () => {
      copyLinkButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(clipboardWriteTextMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Copied");

    await act(async () => {
      revokeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(revokeInviteMock).toHaveBeenCalledWith("invite-25");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the invite selectable when browser clipboard access is unavailable", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[`/${COMPANY_ID}/company/settings/invites`]}
        >
          <QueryClientProvider client={queryClient}>
            <CompanyInvites />
          </QueryClientProvider>
        </TestRouter>,
      );
    });
    await flushReact();
    await flushReact();

    const createButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Create invite",
    );

    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    const inviteInput = container.querySelector(
      'input[aria-label="Latest invite URL"]',
    ) as HTMLInputElement | null;
    expect(inviteInput?.value).toBe("https://paperclip.local/invite/new-token");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Clipboard unavailable",
      body: "Copy the invite URL manually from the field below.",
      tone: "warn",
    });
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Invite created",
      body: "Invite ready below.",
      tone: "success",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("stores invite history under the canonical paginated query key", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <TestRouter
          initialEntries={[`/${COMPANY_ID}/company/settings/invites`]}
        >
          <QueryClientProvider client={queryClient}>
            <CompanyInvites />
          </QueryClientProvider>
        </TestRouter>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Board User 25");
    expect(container.textContent).not.toContain("Board User 20");
    expect(listInvitesMock).toHaveBeenCalledWith(COMPANY_ID, {
      limit: 5,
      offset: 0,
    });
    expect(
      queryClient.getQueryData(queryKeys.access.invites(COMPANY_ID, "all", 5)),
    ).toMatchObject({
      pages: [
        {
          invites: expect.any(Array),
          nextOffset: 5,
        },
      ],
    });

    await act(async () => {
      root.unmount();
    });
  });
});
