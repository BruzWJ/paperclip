// @vitest-environment jsdom

import { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { syncServerAdapters } from "@/adapters/registry";
import { AgentConfigForm } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
  testConfiguration: vi.fn(),
}));

const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");
const AGENT_ID = vi.hoisted(() => "22222222-2222-4222-8222-222222222222");
const REVISION_ID = vi.hoisted(() => "33333333-3333-4333-8333-333333333333");

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useOptionalCompanyRouteId: () => COMPANY_ID,
}));
vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => []),
    getCurrentAdapterConfigRevision: vi.fn(async () => ({
      id: REVISION_ID,
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      revisionNumber: 1,
      acpConfiguration: {
        contractVersion: "acpx-runtime/v1",
        launchProfile: { registryName: "missing-local-agent" },
        sessionConfigSelections: [],
        model: null,
      },
      digest: "a".repeat(64),
      parentRevisionId: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })),
  },
}));
vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));
vi.mock("@/api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));
vi.mock("../../markdown/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => (
    <textarea readOnly value={value} />
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const agent = {
  id: AGENT_ID,
  companyId: COMPANY_ID,
  name: "Test Agent",
  title: null,
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  currentAdapterConfigRevisionId: REVISION_ID,
  pauseReason: null,
  pausedAt: null,
  instruction: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} as unknown as Agent;

type HarnessState = {
  dirty: boolean;
  saveAction: (() => void) | null;
  cancelAction: (() => void) | null;
};

let harnessState: HarnessState;
let queryClient: QueryClient;

/**
 * Mirrors the ConfigurationTab wiring in AgentDetail: the registered save and
 * cancel actions live in React state, so an action re-registered on every
 * render (fresh function identity) re-renders the harness, which re-runs the
 * form's registration effect — the "maximum update depth exceeded" loop this
 * regression test guards.
 */
function Harness({
  onSave,
}: {
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const [saveAction, setSaveAction] = useState<(() => void) | null>(null);
  const [cancelAction, setCancelAction] = useState<(() => void) | null>(null);
  const handleSaveActionChange = useCallback((action: (() => void) | null) => {
    setSaveAction(() => action);
  }, []);
  const handleCancelActionChange = useCallback(
    (action: (() => void) | null) => {
      setCancelAction(() => action);
    },
    [],
  );
  harnessState = { dirty, saveAction, cancelAction };
  return (
    <AgentConfigForm
      mode="edit"
      agent={agent}
      onSave={onSave}
      onDirtyChange={setDirty}
      onSaveActionChange={handleSaveActionChange}
      onCancelActionChange={handleCancelActionChange}
      hideInlineSave
      sectionLayout="cards"
    />
  );
}

function CreateHarness() {
  const [values, setValues] = useState({
    ...defaultCreateValues,
    adapterType: "missing-local-agent",
  });
  return (
    <AgentConfigForm
      mode="create"
      values={values}
      onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
    />
  );
}

describe("AgentConfigForm", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    syncServerAdapters([]);
    mockAdaptersApi.list.mockResolvedValue([]);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    syncServerAdapters([]);
    vi.clearAllMocks();
  });

  function render(
    onSave: (patch: Record<string, unknown>) => void = () => undefined,
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Harness onSave={onSave} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("settles after mount instead of looping action registration", () => {
    render();

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Agent name"]',
    );
    expect(nameInput).not.toBeNull();
    expect(nameInput!.value).toBe("Test Agent");
    expect(harnessState!.dirty).toBe(false);
    expect(typeof harnessState!.saveAction).toBe("function");
    expect(typeof harnessState!.cancelAction).toBe("function");
  });

  it("registered save action delegates to the latest draft", () => {
    const onSave = vi.fn();
    render(onSave);

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Agent name"]',
    )!;
    act(() => setInputValue(nameInput, "Renamed Agent"));

    expect(harnessState!.dirty).toBe(true);

    // The action registered on mount must invoke the current handlers, not a
    // stale closure from the first render.
    const mountedSaveAction = harnessState!.saveAction!;
    act(() => {
      void mountedSaveAction();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed Agent" }),
    );
  });

  it("keeps the registered action identity stable across dirty transitions", () => {
    render();
    const mountedSaveAction = harnessState!.saveAction;

    const nameInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="Agent name"]',
    )!;
    act(() => setInputValue(nameInput, "Renamed Agent"));

    expect(harnessState!.saveAction).toBe(mountedSaveAction);
  });

  it("uses an adapter that arrives after the form's first render", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "missing-local-agent",
        label: "Available local agent",
        modelsCount: 0,
        loaded: true,
        configOptions: [],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: [],
        },
      },
    ]);

    render();

    await act(async () => {
      await vi.waitFor(() => {
        expect(
          [...container.querySelectorAll("button")].some(
            (button) => button.textContent === "Test Agent",
          ),
        ).toBe(true);
      });
    });
  });

  it("does not test a draft whose advertised required settings are absent", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "missing-local-agent",
        label: "Available local agent",
        modelsCount: 1,
        loaded: true,
        configOptions: [
          {
            id: "model",
            label: "Model",
            type: "select",
            values: [{ label: "GPT-5.6", value: "gpt-5.6" }],
          },
        ],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: [],
        },
      },
    ]);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CreateHarness />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await vi.waitFor(() => {
        const button = [...container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent === "Test Agent",
        );
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(true);
        expect(container.textContent).toContain(
          "Complete the required ACPX settings before testing: Model requires an exact value.",
        );
      });
    });
    expect(mockAdaptersApi.testConfiguration).not.toHaveBeenCalled();
  });

  it("materializes an advertised current value before testing it", async () => {
    mockAdaptersApi.list.mockResolvedValue([
      {
        type: "missing-local-agent",
        label: "Available local agent",
        modelsCount: 1,
        loaded: true,
        configOptions: [
          {
            id: "model",
            label: "Model",
            type: "select",
            currentValue: "gpt-5.6",
            values: [{ label: "GPT-5.6", value: "gpt-5.6" }],
          },
        ],
        capabilities: {
          contractVersion: "acpx-runtime/v1",
          runtimeControls: [],
        },
      },
    ]);
    mockAdaptersApi.testConfiguration.mockResolvedValue({
      status: "ready",
      adapterType: "missing-local-agent",
      runtimeControls: [],
      testedAt: "2026-08-12T20:00:00.000Z",
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CreateHarness />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    let button: HTMLButtonElement | undefined;
    await act(async () => {
      await vi.waitFor(() => {
        button = [...container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent === "Test Agent",
        );
        expect(button).toBeDefined();
        expect(button!.disabled).toBe(false);
        expect(
          container.querySelector('[aria-label="Model"]')?.textContent,
        ).toContain("GPT-5.6");
      });
    });
    act(() => button!.click());
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockAdaptersApi.testConfiguration).toHaveBeenCalledWith(
          COMPANY_ID,
          "missing-local-agent",
          { adapterConfig: { model: "gpt-5.6" } },
        );
      });
    });
  });
});
