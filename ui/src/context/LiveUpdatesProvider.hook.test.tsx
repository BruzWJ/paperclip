// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { LiveEvent, LiveEventOf } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __liveUpdatesTestUtils,
  useCompanyLiveEvent,
  useIssueExecutionLivePlan,
  type CompanyLiveEventHandler,
} from "./LiveUpdatesProvider";
import {
  createIssueExecutionLivePlanStore,
  type VisibleActiveIssueExecutionPrompt,
} from "../lib/issue-execution-live-plan";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  IssueExecutionLivePlanContext,
  LiveEventSubscriptionContext,
  dispatchLiveEventToSubscribers,
} = __liveUpdatesTestUtils;

function act(callback: () => void) {
  flushSync(callback);
}

function agentStatusEvent(
  overrides: Partial<LiveEventOf<"agent.status">> = {},
): LiveEventOf<"agent.status"> {
  return {
    id: 1,
    companyId: "company-1",
    type: "agent.status",
    createdAt: "2026-07-15T00:00:00.000Z",
    payload: {
      agentId: "agent-1",
      status: "running",
    },
    ...overrides,
  };
}

describe("useCompanyLiveEvent", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function renderWithSubscription(handler: CompanyLiveEventHandler) {
    const subscribers = new Set<CompanyLiveEventHandler>();
    const subscription = {
      subscribe: (fn: CompanyLiveEventHandler) => {
        subscribers.add(fn);
        return () => {
          subscribers.delete(fn);
        };
      },
    };

    function Consumer() {
      useCompanyLiveEvent(handler);
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(
        <LiveEventSubscriptionContext.Provider value={subscription}>
          <Consumer />
        </LiveEventSubscriptionContext.Provider>,
      );
    });

    return subscribers;
  }

  it("receives events dispatched through the shared registry", () => {
    const received: LiveEvent[] = [];
    const subscribers = renderWithSubscription((event) => received.push(event));

    act(() => dispatchLiveEventToSubscribers(subscribers, "company-1", agentStatusEvent()));

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event.type).toBe("agent.status");
    if (event.type === "agent.status") {
      expect(event.payload.agentId).toBe("agent-1");
    }
  });

  it("stops receiving events after unmount", () => {
    const received: LiveEvent[] = [];
    const subscribers = renderWithSubscription((event) => received.push(event));

    act(() => root?.unmount());
    root = null;

    act(() => dispatchLiveEventToSubscribers(subscribers, "company-1", agentStatusEvent()));

    expect(received).toHaveLength(0);
  });

  it("no-ops without a surrounding provider", () => {
    function Consumer() {
      useCompanyLiveEvent(() => {
        throw new Error("should never be called");
      });
      return null;
    }

    root = createRoot(container);
    expect(() =>
      act(() => {
        root!.render(<Consumer />);
      }),
    ).not.toThrow();
  });
});

describe("useIssueExecutionLivePlan", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const prompt: VisibleActiveIssueExecutionPrompt = {
    companyId: "company-1",
    issueId: "issue-1",
    runId: "run-1",
    refId: "ref-1",
    runOrdinal: 1,
    segmentOrdinal: 0,
    promptActive: true,
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("renders only the registered prompt replacement and clears at terminal", () => {
    const store = createIssueExecutionLivePlanStore();

    function Consumer({
      visible,
    }: {
      visible: VisibleActiveIssueExecutionPrompt | null;
    }) {
      const livePlan = useIssueExecutionLivePlan(visible);
      return (
        <output>
          {livePlan === null
            ? "not-seen"
            : JSON.stringify(livePlan.replacement)}
        </output>
      );
    }

    const render = (visible: VisibleActiveIssueExecutionPrompt | null) => {
      root ??= createRoot(container);
      act(() => {
        root!.render(
          <IssueExecutionLivePlanContext.Provider value={{ store }}>
            <Consumer visible={visible} />
          </IssueExecutionLivePlanContext.Provider>,
        );
      });
    };

    render(prompt);
    expect(container.textContent).toBe("not-seen");

    act(() => {
      store.acceptEvent({
        id: 1,
        companyId: prompt.companyId,
        type: "issue.execution.plan.live",
        createdAt: "2026-07-31T00:00:00.000Z",
        payload: {
          companyId: prompt.companyId,
          issueId: prompt.issueId,
          runId: prompt.runId,
          refId: prompt.refId,
          runOrdinal: prompt.runOrdinal,
          segmentOrdinal: prompt.segmentOrdinal,
          replacement: [],
        },
      });
    });
    expect(container.textContent).toBe("[]");

    render(null);
    expect(container.textContent).toBe("not-seen");
  });

  it("has no fallback or hydrated state outside the provider", () => {
    function Consumer() {
      const livePlan = useIssueExecutionLivePlan(prompt);
      return <output>{livePlan === null ? "not-seen" : "unexpected"}</output>;
    }

    root = createRoot(container);
    act(() => root!.render(<Consumer />));
    expect(container.textContent).toBe("not-seen");
  });
});
