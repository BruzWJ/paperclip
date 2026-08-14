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
  useGetSessionMockTestState,
  useSignInEmailMockTestState,
  useSignUpEmailMockTestState,
} from "./-InviteLanding-test-support";
const acceptInviteMock = useAcceptInviteMockTestState();
const getSessionMock = useGetSessionMockTestState();
const signInEmailMock = useSignInEmailMockTestState();
const signUpEmailMock = useSignUpEmailMockTestState();
describe("InviteLandingPage", () => {
  let container: HTMLDivElement;
  let cleanup: () => void;
  beforeEach(() => {
    ({ container, cleanup } = setupInviteLandingTest());
  });
  afterEach(() => {
    cleanup();
  });
  it("defaults invite auth to account creation and guides existing users back to sign in", async () => {
    signUpEmailMock.mockRejectedValue(
      Object.assign(new Error("User already exists. Use another email."), {
        code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
        status: 422,
      }),
    );
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("You've been invited to join Paperclip");
    expect(container.textContent).toContain("Join Acme Robotics");
    expect(container.textContent).toContain("Create account");
    expect(container.textContent).toContain("I already have an account");
    expect(container.querySelector('[data-testid="invite-inline-auth"]')).not.toBeNull();
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBe("pcp_invite_test");
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
    expect(container.querySelector('input[name="name"]')).not.toBeNull();
    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement | null;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");
    await act(async () => {
      inputValueSetter!.call(nameInput, "Jane Example");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput!.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "supersecret");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const authForm = container.querySelector('[data-testid="invite-inline-auth"]') as HTMLFormElement | null;
    expect(authForm).not.toBeNull();
    await act(async () => {
      authForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();
    await flushReact();
    expect(signUpEmailMock).toHaveBeenCalledWith({
      name: "Jane Example",
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(container.textContent).toContain(
      "An account already exists for jane@example.com. Sign in below to continue with this invite.",
    );
    expect(container.querySelector('input[name="name"]')).toBeNull();
    expect(container.textContent).toContain("Sign in to continue");
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBe("pcp_invite_test");
    await act(async () => {
      root.unmount();
    });
  });
  it("carries password-manager metadata and a11y attributes on the invite auth form", async () => {
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    // Default invite mode is sign-up and identifies the account by email.
    expect(emailInput.getAttribute("autocomplete")).toBe("email");
    expect(emailInput.getAttribute("type")).toBe("email");
    expect(passwordInput.getAttribute("autocomplete")).toBe("new-password");
    expect(nameInput.getAttribute("autocomplete")).toBe("name");
    // Namespaced stable ids.
    expect(emailInput.id).toBe("invite-email");
    expect(passwordInput.id).toBe("invite-password");
    expect(nameInput.id).toBe("invite-name");
    // Required + programmatic required state.
    expect(emailInput.required).toBe(true);
    expect(emailInput.getAttribute("aria-required")).toBe("true");
    expect(passwordInput.required).toBe(true);
    expect(passwordInput.getAttribute("aria-required")).toBe("true");
    expect(nameInput.required).toBe(true);
    await act(async () => {
      root.unmount();
    });
  });
  it("renders invite auth errors in an alert region referenced by the inputs", async () => {
    signInEmailMock.mockRejectedValue(
      Object.assign(new Error("Invalid email or password"), {
        code: "INVALID_EMAIL_OR_PASSWORD",
        status: 401,
      }),
    );
    const { root, render } = createInviteLandingRenderer(container);
    await render();
    await flushReact();
    await flushReact();
    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const existingAccountButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "I already have an account",
    );
    await act(async () => {
      existingAccountButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement;
    await act(async () => {
      inputValueSetter!.call(emailInput, "jane@example.com");
      emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "wrongpass");
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const authForm = container.querySelector('[data-testid="invite-inline-auth"]') as HTMLFormElement;
    await act(async () => {
      authForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();
    const alert = container.querySelector('[role="alert"]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(alert.hasAttribute("aria-live")).toBe(false);
    const errorId = alert.id;
    expect(errorId.length).toBeGreaterThan(0);
    expect(emailInput.getAttribute("aria-describedby")).toBe(errorId);
    expect(emailInput.getAttribute("aria-invalid")).toBe("true");
    expect(passwordInput.getAttribute("aria-describedby")).toBe(errorId);
    expect(passwordInput.getAttribute("aria-invalid")).toBe("true");
    await act(async () => {
      root.unmount();
    });
  });
  it("turns invalid sign-in responses into a clear invite-specific message", async () => {
    signInEmailMock.mockRejectedValue(
      Object.assign(new Error("Invalid email or password"), {
        code: "INVALID_EMAIL_OR_PASSWORD",
        status: 401,
      }),
    );
    const { root, queryClient, render } = createInviteLandingRenderer(container);
    queryClient.setQueryData(queryKeys.access.currentBoardAccess("user-1"), {
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
    });
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
      emailInput!.dispatchEvent(new Event("change", { bubbles: true }));
      inputValueSetter!.call(passwordInput, "wrongpass");
      passwordInput!.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput!.dispatchEvent(new Event("change", { bubbles: true }));
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
      password: "wrongpass",
    });
    expect(container.textContent).toContain(
      "That email and password did not match an existing Paperclip account. Check both fields, or create an account first if you are new here.",
    );
    await act(async () => {
      root.unmount();
    });
  });
  it("auto-accepts the invite after account creation and redirects into the company", async () => {
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
    acceptInviteMock.mockResolvedValue({
      id: "join-1",
      companyId: COMPANY_ID,
      status: "approved",
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
    const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    expect(inputValueSetter).toBeTypeOf("function");
    const nameInput = container.querySelector('input[name="name"]') as HTMLInputElement | null;
    const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement | null;
    const passwordInput = container.querySelector('input[name="password"]') as HTMLInputElement | null;
    expect(nameInput).not.toBeNull();
    expect(emailInput).not.toBeNull();
    expect(passwordInput).not.toBeNull();
    await act(async () => {
      inputValueSetter!.call(nameInput, "Jane Example");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
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
    await flushReact();
    await flushReact();
    expect(signUpEmailMock).toHaveBeenCalledWith({
      name: "Jane Example",
      email: "jane@example.com",
      password: "supersecret",
    });
    expect(acceptInviteMock).toHaveBeenCalledWith("pcp_invite_test");
    expect(queryClient.getQueryState(queryKeys.access.currentBoardAccess("user-1"))?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryData(queryKeys.companies.all)).toMatchObject({
      companies: [],
      unauthorized: false,
    });
    expect(localStorage.getItem("paperclip:pending-invite-token")).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
