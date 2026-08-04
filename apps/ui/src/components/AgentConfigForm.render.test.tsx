// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeMoneyAmount, type Agent, type Environment } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConfigForm } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModelProfiles: vi.fn(),
  list: vi.fn(),
}));

const mockAdaptersApi = vi.hoisted(() => ({
  testConfiguration: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));
const mockAdapterDrivers = vi.hoisted(() => ({
  value: ["local", "ssh", "sandbox", "plugin"] as string[],
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    selectionSource: "bootstrap",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("../adapters", () => ({
  findUIAdapter: (type: string) => ({
    type,
    label: "Codex",
    drivers: mockAdapterDrivers.value,
    ConfigFields: () => (
      <div data-testid="server-config-fields">Server schema fields</div>
    ),
    buildAdapterConfig: (values: { adapterSchemaValues?: Record<string, unknown> }) => ({
      ...(values.adapterSchemaValues ?? {}),
    }),
  }),
}));

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsModelProfiles: false,
    contractVersion: "acpx-runtime/v1",
    runtimeControls: ["session/status", "session/set_config_option"],
  }),
}));

vi.mock("../adapters/use-adapter-catalog", () => ({
  useAdapterCatalogSync: () => [],
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Markdown"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Cody",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    contextMode: "thin",
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    governance: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Agent;
}

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

async function renderForm(
  environments: Environment[],
  agentOverrides: Partial<Agent> = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="edit"
            agent={makeAgent(agentOverrides)}
            onSave={vi.fn()}
            showAdapterTypeField={false}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root };
}

async function renderCreateForm(
  environments: Environment[],
  adapterSchemaValues: Record<string, unknown>,
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const rerender = async (
    nextAdapterSchemaValues: Record<string, unknown>,
  ) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AgentConfigForm
              mode="create"
              values={{
                ...defaultCreateValues,
                adapterType: "codex",
                defaultEnvironmentId: "local-1",
                adapterSchemaValues: nextAdapterSchemaValues,
              }}
              onChange={vi.fn()}
              showAdapterTypeField={false}
            />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  };

  await rerender(adapterSchemaValues);
  return { container, root, rerender };
}

async function renderCreateFormWithDeferredTest(
  environments: Environment[],
  adapterSchemaValues: Record<string, unknown>,
) {
  let resolveTest: ((value: {
    status: "ready";
    adapterType: string;
    runtimeControls: string[];
    testedAt: string;
  }) => void) | undefined;
  mockAdaptersApi.testConfiguration.mockImplementationOnce(
    async () => await new Promise((resolve) => {
      resolveTest = resolve;
    }),
  );
  const rendered = await renderCreateForm(
    environments,
    adapterSchemaValues,
  );
  return {
    ...rendered,
    resolveTest: () => {
      if (!resolveTest) throw new Error("Draft test did not start");
      resolveTest({
        status: "ready",
        adapterType: "codex",
        runtimeControls: ["session/status", "session/set_config_option"],
        testedAt: "2026-08-04T00:00:00.000Z",
      });
    },
  };
}

describe("AgentConfigForm environment selector", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAdapterDrivers.value = ["local", "ssh", "sandbox", "plugin"];
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAdaptersApi.testConfiguration.mockResolvedValue({
      status: "ready",
      adapterType: "codex",
      runtimeControls: ["session/status", "session/set_config_option"],
      testedAt: "2026-08-04T00:00:00.000Z",
    });
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides the environment override when Local is the only configured environment", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ]);
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Environment override");
    expect(result.container.querySelector("select")).toBeNull();
  });

  it("shows concise Environment copy when one runnable non-local environment exists", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "E2B",
        driver: "sandbox",
        config: { provider: "e2b" },
      }),
    ]);
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector("select");

    expect(text).toContain("Environment");
    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("Default: Local");
    expect(selector?.textContent).toContain("E2B · sandbox");
    expect(text).not.toContain("Execution");
    expect(text).not.toContain("Leave this unset to inherit the instance default");
    expect(text).not.toContain("Inherit instance default");
  });

  it("does not advertise an unsupported persisted environment override", async () => {
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "fake-sandbox-1",
          name: "Fake Sandbox",
          driver: "sandbox",
          config: { provider: "fake" },
        }),
      ],
      { defaultEnvironmentId: "fake-sandbox-1" },
    );
    roots.push(result.root);

    const text = result.container.textContent ?? "";

    expect(text).not.toContain("Environment override");
    expect(text).not.toContain("Fake Sandbox · sandbox");
    expect(result.container.querySelector("select")).toBeNull();
  });

  it("filters environments to the exact ACPX-admitted driver set", async () => {
    mockAdapterDrivers.value = ["local"];
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "E2B",
        driver: "sandbox",
        config: { provider: "e2b" },
      }),
    ]);
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Environment override");
    expect(result.container.textContent).not.toContain("E2B · sandbox");
  });

  it("renders server-owned ACP config fields in the Adapter card", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {
        adapterType: "codex",
        adapterConfig: {
          model: "gpt-5.6",
        },
      },
    );
    roots.push(result.root);

    expect(result.container.querySelector('[data-testid="server-config-fields"]')).toBeTruthy();
    expect(result.container.textContent).toContain("Server schema fields");
  });

  it("tests the exact unsaved ACPX configuration without saving the agent", async () => {
    const result = await renderCreateForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {
        model: "gpt-5.6",
        reasoning_effort: "high",
      },
    );
    roots.push(result.root);

    const testButton = Array.from(
      result.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Test Agent");
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAdaptersApi.testConfiguration).toHaveBeenCalledWith(
      "company-1",
      "codex",
      {
        adapterConfig: {
          model: "gpt-5.6",
          reasoning_effort: "high",
        },
      },
    );
    expect(result.container.textContent).toContain(
      "ACPX accepted this exact draft configuration.",
    );
  });

  it("does not restore stale success feedback when a draft changes away and back", async () => {
    const originalConfiguration = {
      model: "gpt-5.6",
      reasoning_effort: "high",
    };
    const result = await renderCreateForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      originalConfiguration,
    );
    roots.push(result.root);

    const testButton = Array.from(
      result.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Test Agent");
    await act(async () => {
      testButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(result.container.textContent).toContain(
      "ACPX accepted this exact draft configuration.",
    );

    await result.rerender({
      ...originalConfiguration,
      reasoning_effort: "low",
    });
    expect(result.container.textContent).not.toContain(
      "ACPX accepted this exact draft configuration.",
    );

    await result.rerender(originalConfiguration);
    expect(result.container.textContent).not.toContain(
      "ACPX accepted this exact draft configuration.",
    );
    expect(mockAdaptersApi.testConfiguration).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending test response after its draft context changed", async () => {
    const originalConfiguration = {
      model: "gpt-5.6",
      reasoning_effort: "high",
    };
    const result = await renderCreateFormWithDeferredTest(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      originalConfiguration,
    );
    roots.push(result.root);

    const testButton = Array.from(
      result.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Test Agent");
    await act(async () => {
      testButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    await result.rerender({
      ...originalConfiguration,
      reasoning_effort: "low",
    });
    await result.rerender(originalConfiguration);
    await act(async () => {
      result.resolveTest();
    });
    await flushReact();

    expect(result.container.textContent).not.toContain(
      "ACPX accepted this exact draft configuration.",
    );
    expect(mockAdaptersApi.testConfiguration).toHaveBeenCalledTimes(1);
  });

});
