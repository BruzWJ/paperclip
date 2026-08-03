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

  function render(agentId?: string) {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RuntimeAgentConfigurationFields
          companyId="company-1"
          agentId={agentId}
          value={createEmptyRuntimeAgentConfigurationValues()}
          onChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
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
    await act(async () => render("agent-1"));
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
});
