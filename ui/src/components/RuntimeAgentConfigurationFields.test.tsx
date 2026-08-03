// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeAgentConfigurationFields,
  createEmptyRuntimeAgentConfigurationValues,
  type RuntimeAgentConfigurationValues,
} from "./RuntimeAgentConfigurationFields";

const agentsApiMock = vi.hoisted(() => ({
  listCreateRuntimeAgentToolOptions: vi.fn(),
  listRuntimeAgentToolOptions: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: agentsApiMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("RuntimeAgentConfigurationFields company-tool options", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = [
      {
        catalogEntryId:
          "11111111-1111-4111-8111-111111111111",
        connectionId:
          "22222222-2222-4222-8222-222222222222",
        connectionName: "Records",
        title: "Lookup record",
        description: "Look up a record",
        catalogVersionHash: "catalog-v1",
      },
    ];
    agentsApiMock.listCreateRuntimeAgentToolOptions.mockResolvedValue(
      options,
    );
    agentsApiMock.listRuntimeAgentToolOptions.mockResolvedValue(options);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  function render({
    agentId,
    value = createEmptyRuntimeAgentConfigurationValues(),
    onChange = () => undefined,
  }: {
    agentId?: string;
    value?: RuntimeAgentConfigurationValues;
    onChange?: (value: RuntimeAgentConfigurationValues) => void;
  } = {}) {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RuntimeAgentConfigurationFields
          companyId="company-1"
          agentId={agentId}
          value={value}
          onChange={onChange}
        />
      </QueryClientProvider>,
    );
    return onChange;
  }

  it("loads create options from the dedicated company-installed catalog", async () => {
    await act(async () => render());
    await flushReact();

    expect(
      agentsApiMock.listCreateRuntimeAgentToolOptions,
    ).toHaveBeenCalledWith("company-1");
    expect(
      agentsApiMock.listRuntimeAgentToolOptions,
    ).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Lookup record");
    expect(container.textContent).toContain(
      "bound to the new agent atomically",
    );
  });

  it("loads edit options only from the exact-agent catalog", async () => {
    await act(async () => render({ agentId: "agent-1" }));
    await flushReact();

    expect(
      agentsApiMock.listRuntimeAgentToolOptions,
    ).toHaveBeenCalledWith("agent-1", "company-1");
    expect(
      agentsApiMock.listCreateRuntimeAgentToolOptions,
    ).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "installed for this exact agent",
    );
  });

  it("uses one nine-cell attention matrix for the agent context grants", async () => {
    const value = createEmptyRuntimeAgentConfigurationValues();
    const onChange = vi.fn();
    await act(async () => render({ value, onChange }));

    const matrix = container.querySelector(
      '[data-testid="agent-attention-matrix"]',
    );
    expect(matrix).not.toBeNull();
    expect(matrix!.querySelectorAll('[role="checkbox"]')).toHaveLength(9);
    expect(matrix!.querySelectorAll('[aria-label$=": blocked"]')).toHaveLength(
      9,
    );
    expect(container.textContent).not.toContain("Carry current-issue session");
    expect(container.textContent).not.toContain("Current issue · comments");

    const currentContent = matrix!.querySelector<HTMLButtonElement>(
      '[aria-label="Current issue Content: blocked"]',
    );
    expect(currentContent).not.toBeNull();
    act(() => currentContent!.click());

    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      contextGrants: {
        ...value.contextGrants,
        carry_context: true,
      },
    });
  });
});
