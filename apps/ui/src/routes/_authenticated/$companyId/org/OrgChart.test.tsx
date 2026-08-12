// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { canonicalizeMoneyAmount } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRouter } from "@/test/TestRouter";
import { OrgChart } from ".";

const orgMock = vi.fn();
const listMock = vi.fn();

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const LEAD_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ENGINEER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ORG_PATH = `/${COMPANY_ID}/org`;

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
    list: () => listMock(),
  },
}));

vi.mock("@/components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const orgTree = [
  {
    id: LEAD_AGENT_ID,
    name: "Lead",
    subtitle: "Lead",
    status: "idle",
    reports: [
      {
        id: ENGINEER_AGENT_ID,
        name: "Engineer",
        subtitle: "Engineer",
        status: "idle",
        reports: [],
      },
    ],
  },
];

const agents = [
  {
    id: LEAD_AGENT_ID,
    companyId: COMPANY_ID,
    name: "Lead",
    subtitle: "Lead",
    title: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    icon: "briefcase",
    instruction: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    pauseReason: null,
    pausedAt: null,
  },
  {
    id: ENGINEER_AGENT_ID,
    companyId: COMPANY_ID,
    name: "Engineer",
    subtitle: "Engineer",
    title: null,
    status: "idle",
    reportsTo: LEAD_AGENT_ID,
    capabilities: null,
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    icon: "code",
    instruction: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    pauseReason: null,
    pausedAt: null,
  },
];

function createTouchEvent(
  type: string,
  touches: Array<{ clientX: number; clientY: number }>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: touches,
  });
  Object.defineProperty(event, "changedTouches", {
    value: touches,
  });
  return event;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("OrgChart mobile gestures", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  const routerRef: { current: AnyRouter | null } = { current: null };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(agents);
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport"
          ? 360
          : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport"
          ? 520
          : 0;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getRect(this: HTMLElement) {
        if (this.getAttribute("data-testid") === "org-chart-viewport") {
          return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 360,
            bottom: 520,
            width: 360,
            height: 520,
            toJSON: () => ({}),
          };
        }
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON: () => ({}),
        };
      },
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderOrgChart() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <TestRouter initialEntries={[ORG_PATH]} routerRef={routerRef}>
          <QueryClientProvider client={queryClient}>
            <OrgChart />
          </QueryClientProvider>
        </TestRouter>,
      );
    });
    await flushReact();
    await flushReact();
    return {
      viewport: container.querySelector(
        '[data-testid="org-chart-viewport"]',
      ) as HTMLDivElement,
      layer: container.querySelector(
        '[data-testid="org-chart-card-layer"]',
      ) as HTMLDivElement,
    };
  }

  it("pans the chart with one-finger touch drag", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(
        createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]),
      );
      viewport.dispatchEvent(
        createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]),
      );
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(50px, 105px) scale(1)");
  });

  it("suppresses card navigation after a touch pan", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(
        createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]),
      );
      viewport.dispatchEvent(
        createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]),
      );
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(routerRef.current?.state.location.pathname).toBe(ORG_PATH);
  });

  it("allows card navigation after a touch tap without movement", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(
        createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]),
      );
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    await vi.waitFor(() => {
      expect(routerRef.current?.state.location.pathname).toBe(
        `/${COMPANY_ID}/agents/${LEAD_AGENT_ID}`,
      );
    });
  });
  it("pinch-zooms toward the touch center", async () => {
    const { viewport, layer } = await renderOrgChart();

    await act(async () => {
      viewport.dispatchEvent(
        createTouchEvent("touchstart", [
          { clientX: 100, clientY: 100 },
          { clientX: 200, clientY: 100 },
        ]),
      );
      viewport.dispatchEvent(
        createTouchEvent("touchmove", [
          { clientX: 75, clientY: 100 },
          { clientX: 225, clientY: 100 },
        ]),
      );
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    expect(layer.style.transform).toBe("translate(-45px, 40px) scale(1.5)");
  });
});
