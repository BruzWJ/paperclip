// @vitest-environment jsdom
import "./-InviteLanding-test-support";
import { queryKeys } from "@/lib/queryKeys";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  COMPANY_ID,
  createInviteLandingRenderer,
  flushReact,
  setupInviteLandingTest,
  useAcceptInviteMockTestState,
  useGetInviteMockTestState,
  useGetSessionMockTestState,
  useListCompaniesMockTestState,
  useSignInEmailMockTestState,
} from "./-InviteLanding-test-support";
const getInviteMock = useGetInviteMockTestState();
const acceptInviteMock = useAcceptInviteMockTestState();
const getSessionMock = useGetSessionMockTestState();
const signInEmailMock = useSignInEmailMockTestState();
const listCompaniesMock = useListCompaniesMockTestState();
describe("InviteLandingPage", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupInviteLandingTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("shows the pending approval page with the company icon and non-clickable access instructions", async () => {
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: COMPANY_ID,
      status: "pending_approval",
    });
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    await flushReact();
    await flushReact();
    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test");
    expect(container.textContent).toContain("Request to join Acme Robotics");
    expect(container.textContent).toContain("A company admin must approve your request to join.");
    expect(container.textContent).toContain(
      "Ask them to visit Company Settings → Members to approve your request.",
    );
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(container.textContent).not.toContain("http://localhost/company/settings/members");
    // The "Company Settings → Members" guidance addresses the company admin,
    // not the requester. It must render as plain text so the requester cannot
    // navigate themselves to /company/settings/members — a route they have no
    // permission to view, which renders a misleading "No company access"
    // panel and makes the invite flow look broken. See #6784.
    const approvalAnchors = Array.from(container.querySelectorAll("a")).filter(
      (link) => link.textContent === "Company Settings → Members",
    );
    expect(approvalAnchors).toHaveLength(0);
    const approvalMentions = container.textContent?.match(/Company Settings → Members/g) ?? [];
    expect(approvalMentions).toHaveLength(2);
    await act(async () => {
      root.unmount();
    });
  });
  it("auto-completes a previously accepted user invite after sign-in", async () => {
    getInviteMock.mockResolvedValue({
      id: "invite-1",
      companyId: COMPANY_ID,
      companyName: "Acme Robotics",
      companyLogoUrl: "/api/invites/pcp_invite_test/logo",
      companyBrandColor: "#114488",
      inviteType: "company_join",
      userRole: "operator",
      expiresAt: "2027-03-07T00:10:00.000Z",
      joinRequestStatus: "pending_approval",
    });
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: COMPANY_ID,
      status: "approved",
    });
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    const { root, queryClient, render } = createInviteLandingRenderer(container);
    queryClient.setQueryData(queryKeys.access.currentBoardAccess("user-1"), {
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
    });
    await render();
    await flushReact();
    await flushReact();
    await flushReact();
    await flushReact();
    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test");
    expect(queryClient.getQueryState(queryKeys.access.currentBoardAccess("user-1"))?.isInvalidated).toBe(
      true,
    );
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
  it("asks unauthenticated users to sign in before completing an accepted user invite", async () => {
    getInviteMock.mockResolvedValue({
      id: "invite-1",
      companyId: COMPANY_ID,
      companyName: "Acme Robotics",
      companyLogoUrl: "/api/invites/pcp_invite_test/logo",
      companyBrandColor: "#114488",
      inviteType: "company_join",
      userRole: "operator",
      expiresAt: "2027-03-07T00:10:00.000Z",
      joinRequestStatus: "pending_approval",
    });
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    expect(acceptInviteMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="invite-inline-auth"]')).not.toBeNull();
    expect(container.textContent).toContain("Create your account");
    expect(container.querySelector('[data-testid="invite-pending-approval"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
  it("redirects straight to the company after sign-in when the user already has access", async () => {
    getSessionMock.mockResolvedValueOnce(null);
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    listCompaniesMock.mockResolvedValue([{ id: COMPANY_ID, name: "Acme Robotics" }]);
    const { root, queryClient, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");
    const existingAccountButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "I already have an account",
    );
    expect(existingAccountButton).not.toBeNull();
    await act(async () => {
      existingAccountButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    await act(async () => {
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "supersecret");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const authForm = container.querySelector('[data-testid="invite-inline-auth"]') as HTMLFormElement | null;
    expect(authForm).not.toBeNull();
    await act(async () => {
      authForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();
    expect(signInEmailMock).toHaveBeenCalledWith({
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(acceptInviteMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.companies.all)).toMatchObject({
      companies: [{ id: COMPANY_ID, name: "Acme Robotics" }],
      unauthorized: false,
    });
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
  it("shows invite details instead of auto-redirecting for signed-in existing members", async () => {
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    listCompaniesMock.mockResolvedValue([{ id: COMPANY_ID, name: "Acme Robotics" }]);
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Join Acme Robotics");
    expect(container.textContent).toContain("Already in this company");
    expect(container.textContent).toContain("This account already belongs to Acme Robotics.");
    expect(acceptInviteMock).not.toHaveBeenCalled();
    const openButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Open company",
    );
    expect(openButton).not.toBeNull();
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await act(async () => {
      root.unmount();
    });
  });
  it("shows the company initial while the invite logo is unavailable", async () => {
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    expect(container.querySelector('[data-slot="avatar-fallback"]')?.textContent).toBe("A");
    await act(async () => {
      root.unmount();
    });
  });
  it("normalizes the shared company cache envelope before checking membership", async () => {
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: COMPANY_ID,
      status: "pending_approval",
    });
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    const { root, queryClient, render } = createInviteLandingRenderer(container);
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [],
      unauthorized: false,
    });
    await render();
    await flushReact();
    await flushReact();
    await flushReact();
    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test");
    expect(container.textContent).toContain("Request to join Acme Robotics");
    await act(async () => {
      root.unmount();
    });
  });
  it("waits for the membership check before showing invite acceptance to signed-in users", async () => {
    let resolveCompanies: ((value: Array<{ id: string; name: string }>) => void) | null = null;
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: COMPANY_ID,
      status: "pending_approval",
    });
    listCompaniesMock.mockImplementation(
      () =>
        new Promise<Array<{ id: string; name: string }>>((resolve) => {
          resolveCompanies = resolve;
        }),
    );
    getSessionMock.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    expect(container.textContent).toContain("Checking your access...");
    expect(container.textContent).not.toContain("Accept company invite");
    expect(acceptInviteMock).not.toHaveBeenCalled();
    await act(async () => {
      resolveCompanies?.([]);
    });
    await flushReact();
    await flushReact();
    await flushReact();
    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test");
    expect(container.textContent).toContain("Request to join Acme Robotics");
    await act(async () => {
      root.unmount();
    });
  });
});
