// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboxAgentPolicy } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxAgentPolicyControl } from "./InboxAgentPolicyControl";

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockInboxAgentPolicyApi = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}));
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const GARDENER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CODER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RETIRED_AGENT_ID = "44444444-4444-4444-8444-444444444444";

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/inbox-agent-policy", () => ({
  inboxAgentPolicyApi: mockInboxAgentPolicyApi,
}));
vi.mock("./AgentIconPicker", () => ({ AgentIcon: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function policy(overrides: Partial<InboxAgentPolicy> = {}): InboxAgentPolicy {
  return {
    companyId: COMPANY_ID,
    userId: "user-1",
    mode: "open",
    allowedAgentIds: [],
    materialized: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function render(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <InboxAgentPolicyControl companyId={COMPANY_ID} userId="user-1" />
      </QueryClientProvider>,
    );
  });
  return root;
}

function optionByTitle(container: HTMLElement, title: string) {
  const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.includes(title));
  return label?.querySelector('[role="radio"]') as HTMLButtonElement | undefined;
}

describe("InboxAgentPolicyControl", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([
      { id: GARDENER_AGENT_ID, name: "Gardener", status: "idle", icon: null },
      { id: CODER_AGENT_ID, name: "Coder", status: "idle", icon: null },
      {
        id: RETIRED_AGENT_ID,
        name: "Retired",
        status: "terminated",
        icon: null,
      },
    ]);
    mockInboxAgentPolicyApi.get.mockResolvedValue(policy());
    mockInboxAgentPolicyApi.update.mockImplementation((_companyId: string, _userId: string, input) =>
      Promise.resolve(policy({ ...input, materialized: true })),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("surfaces policy load failures instead of staying on loading", async () => {
    mockInboxAgentPolicyApi.get.mockRejectedValue(new Error("Policy endpoint failed"));
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Policy endpoint failed");
      expect(container.textContent).not.toContain("Loading inbox agent policy");
    });

    act(() => root.unmount());
  });

  it("renders all three policy states with the persisted mode selected", async () => {
    mockInboxAgentPolicyApi.get.mockResolvedValue(policy({ mode: "disabled" }));
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(optionByTitle(container, "Any of my agents")).toBeTruthy();
      expect(optionByTitle(container, "Only chosen agents")).toBeTruthy();
      expect(optionByTitle(container, "Off")).toBeTruthy();
      expect(optionByTitle(container, "Off")?.getAttribute("aria-checked")).toBe("true");
      expect(optionByTitle(container, "Any of my agents")?.getAttribute("aria-checked")).toBe("false");
    });

    act(() => root.unmount());
  });

  it("round-trips an allowlist selection through the PUT endpoint", async () => {
    const root = render(container);
    await flush();

    // Save disabled until the draft diverges from the persisted policy.
    await waitForAssertion(() => {
      const save = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Save"),
      );
      expect(save?.disabled).toBe(true);
    });

    // Switch to allowlist — only non-terminated agents are selectable.
    await act(async () => optionByTitle(container, "Only chosen agents")!.click());
    await flush();
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Gardener");
      expect(container.textContent).toContain("Coder");
      expect(container.textContent).not.toContain("Retired");
    });

    const gardenerCheckbox = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Allow Gardener to tidy my inbox"]',
    );
    expect(gardenerCheckbox).toBeTruthy();
    await act(async () => gardenerCheckbox!.click());
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save"),
    )!;
    await waitForAssertion(() => expect(saveButton.disabled).toBe(false));

    await act(async () => saveButton.click());
    await flush();

    expect(mockInboxAgentPolicyApi.update).toHaveBeenCalledWith(COMPANY_ID, "user-1", {
      mode: "allowlist",
      allowedAgentIds: [GARDENER_AGENT_ID],
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Saved");
      const save = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Save"),
      );
      expect(save?.disabled).toBe(true);
    });

    act(() => root.unmount());
  });

  it("clears the allowlist when switching to Off before saving", async () => {
    mockInboxAgentPolicyApi.get.mockResolvedValue(
      policy({
        mode: "allowlist",
        allowedAgentIds: [GARDENER_AGENT_ID],
        materialized: true,
      }),
    );
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(optionByTitle(container, "Only chosen agents")?.getAttribute("aria-checked")).toBe("true");
    });

    await act(async () => optionByTitle(container, "Off")!.click());
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Save"),
    )!;
    await waitForAssertion(() => expect(saveButton.disabled).toBe(false));
    await act(async () => saveButton.click());
    await flush();

    expect(mockInboxAgentPolicyApi.update).toHaveBeenCalledWith(COMPANY_ID, "user-1", {
      mode: "disabled",
      allowedAgentIds: [],
    });

    act(() => root.unmount());
  });
});
