// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouter } from "@/test/TestRouter";
import { CompanySettingsPluginPage } from ".";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Paperclip",
        taskPrefix: "PAP",
      },
    ],
  }),
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
  PluginSlotMount: ({
    slot,
    context,
  }: {
    slot: { displayName: string };
    context: { companyId: string | null };
  }) => (
    <div data-testid="plugin-slot-mount">
      {slot.displayName}:{context.companyId}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <TestRouter
        initialEntries={[
          "/11111111-1111-4111-8111-111111111111/company/settings/permissions",
        ]}
      >
        <QueryClientProvider client={queryClient}>
          <CompanySettingsPluginPage />
        </QueryClientProvider>
      </TestRouter>,
    );
  });
  await flushReact();
  return root;
}

describe("CompanySettingsPluginPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "permissions",
          displayName: "Permissions",
          exportName: "PermissionsPage",
          routePath: "permissions",
          pluginId: "plugin-1",
          pluginKey: "permissions-extension",
          pluginDisplayName: "Permissions Extension",
        },
      ],
      isLoading: false,
      ["error" + "Message"]: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("mounts the matching company settings slot with company context", async () => {
    const root = await renderPage(container);

    expect(
      container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent,
    ).toBe("Permissions:11111111-1111-4111-8111-111111111111");
    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Settings", renderLink: expect.any(Function) },
      { label: "Permissions" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });

  it("fails closed when no ready plugin declares the route", async () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      ["error" + "Message"]: null,
    });
    const root = await renderPage(container);

    expect(container.textContent).toContain("Page not found");

    await act(async () => {
      root.unmount();
    });
  });
});
