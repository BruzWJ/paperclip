// @vitest-environment jsdom

import { TestRouter } from "@/test/TestRouter";
import { getRouteComponent } from "@/test/route-component";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { Route } from ".";

export const InviteLandingPage = getRouteComponent(Route);

const getInviteMock = vi.hoisted(() => vi.fn());
const acceptInviteMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const signInEmailMock = vi.hoisted(() => vi.fn());
const signUpEmailMock = vi.hoisted(() => vi.fn());
const healthGetMock = vi.hoisted(() => vi.fn());
const listCompaniesMock = vi.hoisted(() => vi.fn());
export const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/api/access", () => ({
  accessApi: {
    getInvite: (token: string) => getInviteMock(token),
    acceptInvite: (token: string) => acceptInviteMock(token),
  },
}));

vi.mock("@/api/auth", () => ({
  authApi: {
    getSession: () => getSessionMock(),
    signInEmail: (input: unknown) => signInEmailMock(input),
    signUpEmail: (input: unknown) => signUpEmailMock(input),
  },
}));

vi.mock("@/api/health", () => ({
  healthApi: {
    get: () => healthGetMock(),
  },
}));

vi.mock("@/api/companies", () => ({
  companiesApi: {
    list: () => listCompaniesMock(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

export async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

export async function flushReact() {
  await act(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
  flushSync(() => {});
}

export function setupInviteLandingTest() {
  localStorage.clear();
  const container = document.createElement("div");
  document.body.appendChild(container);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({
      fillStyle: "",
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
    })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: vi.fn(() => "data:image/png;base64,stub"),
  });
  getInviteMock.mockResolvedValue({
    id: "invite-1",
    companyId: COMPANY_ID,
    companyName: "Acme Robotics",
    companyLogoUrl: "/api/invites/pcp_invite_test/logo",
    companyBrandColor: "#114488",
    inviteType: "company_join",
    userRole: "operator",
    expiresAt: "2027-03-07T00:10:00.000Z",
  });
  acceptInviteMock.mockReset();
  healthGetMock.mockResolvedValue({ status: "ok" });
  listCompaniesMock.mockResolvedValue([]);
  getSessionMock.mockResolvedValue(null);
  signInEmailMock.mockResolvedValue(undefined);
  signUpEmailMock.mockResolvedValue(undefined);
  return {
    container,
    cleanup: () => {
      container.remove();
      document.body.innerHTML = "";
      vi.clearAllMocks();
    },
  };
}

export function createInviteLandingRenderer(container: HTMLElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    root,
    queryClient,
    render: () =>
      act(async () => {
        root.render(
          <TestRouter initialEntries={["/invite/pcp_invite_test"]}>
            <QueryClientProvider client={queryClient}>
              <InviteLandingPage />
            </QueryClientProvider>
          </TestRouter>,
        );
      }),
  };
}

export function useGetInviteMockTestState() {
  return getInviteMock;
}

export function useAcceptInviteMockTestState() {
  return acceptInviteMock;
}

export function useGetSessionMockTestState() {
  return getSessionMock;
}

export function useSignInEmailMockTestState() {
  return signInEmailMock;
}

export function useSignUpEmailMockTestState() {
  return signUpEmailMock;
}

export function useHealthGetMockTestState() {
  return healthGetMock;
}

export function useListCompaniesMockTestState() {
  return listCompaniesMock;
}
