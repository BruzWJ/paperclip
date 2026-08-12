// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouter } from "@/test/TestRouter";
import { PluginPage } from ".";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PLUGIN_ID = "22222222-2222-4222-8222-222222222222";

const mockUsePluginSlots = vi.hoisted(() => vi.fn());

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
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

vi.mock("@/plugins/slots", async () => {
  const actual =
    await vi.importActual<typeof import("@/plugins/slots")>("@/plugins/slots");
  return {
    resolveRouteSidebarSlot: actual.resolveRouteSidebarSlot,
    usePluginSlots: mockUsePluginSlots,
    PluginSlotMount: ({ slot }: { slot: { displayName: string } }) => (
      <div data-testid="plugin-slot-mount">{slot.displayName}</div>
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function pageContribution(overrides: Partial<{ slots: unknown[] }> = {}) {
  return {
    pluginId: PLUGIN_ID,
    pluginKey: "acme.knowledge-base",
    displayName: "Knowledge Base",
    version: "0.1.0",
    updatedAt: "2026-08-05T00:00:00.000Z",
    slots: [
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki",
        exportName: "WikiPage",
        routePath: "wiki",
      },
    ],
    launchers: [],
    ...overrides,
  };
}

function resolvedSlots(contributions: ReturnType<typeof pageContribution>[]) {
  return contributions.flatMap((contribution) =>
    contribution.slots.map((slot) => ({
      ...(slot as Record<string, unknown>),
      pluginId: contribution.pluginId,
      pluginUpdatedAt: contribution.updatedAt,
      pluginKey: contribution.pluginKey,
      pluginDisplayName: contribution.displayName,
    })),
  );
}

function setContributions(
  contributions: ReturnType<typeof pageContribution>[],
) {
  mockUsePluginSlots.mockReturnValue({
    slots: resolvedSlots(contributions),
    isLoading: false,
    errorMessage: null,
  });
}

async function renderPage(
  container: HTMLDivElement,
  initialEntry = `/${COMPANY_ID}/wiki`,
) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <TestRouter initialEntries={[initialEntry]}>
        <QueryClientProvider client={queryClient}>
          <PluginPage />
        </QueryClientProvider>
      </TestRouter>,
    );
  });
  await flushReact();
  await flushReact();
  return root;
}

describe("PluginPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("renders the breadcrumb and Back button when no routeSidebar is declared", async () => {
    setContributions([pageContribution()]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Plugins", renderLink: expect.any(Function) },
      { label: "Knowledge Base" },
    ]);
    expect(container.textContent).toContain("Back");
    expect(
      container.querySelector(`a[href="/${COMPANY_ID}/dashboard"]`),
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("uses a route title and hides the Back button when a routeSidebar matches the active route", async () => {
    setContributions([
      pageContribution({
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          {
            type: "routeSidebar",
            id: "wiki-sidebar",
            displayName: "Wiki Sidebar",
            exportName: "WikiRouteSidebar",
            routePath: "wiki",
          },
        ],
      }),
    ]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Wiki" }]);
    expect(container.textContent).not.toContain("Back");
    expect(
      container.querySelector(`a[href="/${COMPANY_ID}/dashboard"]`),
    ).toBeNull();
    // Page slot itself still renders.
    expect(
      container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent,
    ).toBe("Wiki");

    await act(async () => {
      root.unmount();
    });
  });

  it("uses the selected plugin page path as the route-sidebar title", async () => {
    setContributions([
      pageContribution({
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          {
            type: "routeSidebar",
            id: "wiki-sidebar",
            displayName: "Wiki Sidebar",
            exportName: "WikiRouteSidebar",
            routePath: "wiki",
          },
        ],
      }),
    ]);

    const root = await renderPage(
      container,
      `/${COMPANY_ID}/wiki/page/templates%3A%3Aindex.md`,
    );

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "index" }]);

    await act(async () => {
      root.unmount();
    });
  });

  it("matches only the exact manifest routePath and fails closed on duplicate owners", async () => {
    setContributions([pageContribution()]);

    let root = await renderPage(container, `/${COMPANY_ID}/WIKI`);
    expect(
      container.querySelector('[data-testid="plugin-slot-mount"]'),
    ).toBeNull();
    await act(async () => {
      root.unmount();
    });

    container.innerHTML = "";
    setContributions([
      pageContribution({
        slots: [
          {
            type: "page",
            id: "wiki-page-a",
            displayName: "Wiki A",
            exportName: "WikiPageA",
            routePath: "wiki",
          },
          {
            type: "page",
            id: "wiki-page-b",
            displayName: "Wiki B",
            exportName: "WikiPageB",
            routePath: "wiki",
          },
        ],
      }),
    ]);

    root = await renderPage(container);
    expect(
      container.querySelector('[data-testid="plugin-slot-mount"]'),
    ).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
