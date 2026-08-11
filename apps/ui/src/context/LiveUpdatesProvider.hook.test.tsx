// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { LiveEvent, LiveEventOf } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __liveUpdatesTestUtils,
  useCompanyLiveEvent,
  type CompanyLiveEventHandler,
} from "./LiveUpdatesProvider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
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
