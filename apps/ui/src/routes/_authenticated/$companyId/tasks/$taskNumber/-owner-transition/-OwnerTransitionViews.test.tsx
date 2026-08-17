// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InterruptOwnerChangeConfirm,
  OwnerChip,
  OwnerRunningBanner,
  PauseAffectsSummaryView,
  type OwnerChipResolvers,
} from "./-OwnerTransitionViews";
import { computePauseAffectsSummary, describeOwnerChangeInterrupt } from "@/lib/owner-transition";

const resolvers: OwnerChipResolvers = {
  agentMap: new Map([
    ["agent-qa", { name: "QA", icon: null }],
    ["agent-coder", { name: "ClaudeCoder", icon: null }],
  ]),
  resolveUserLabel: (id) => (id === "user-board" ? "Riley Board" : null),
  currentUserId: "user-board",
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(node));
  return host;
}

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("owner transition views", () => {
  it("renders canonical owner kinds distinctly", () => {
    const view = mount(
      <>
        <OwnerChip
          owner={{
            ownerKind: "agent",
            ownerAgentId: "agent-qa",
            ownerUserId: null,
          }}
          resolvers={resolvers}
        />
        <OwnerChip
          owner={{
            ownerKind: "user",
            ownerAgentId: null,
            ownerUserId: "user-board",
          }}
          resolvers={resolvers}
        />
        <OwnerChip
          owner={{ ownerKind: "board", ownerAgentId: null, ownerUserId: null }}
          resolvers={resolvers}
        />
      </>,
    );
    expect(
      [...view.querySelectorAll("[data-testid='owner-chip']")].map((chip) => chip.getAttribute("data-kind")),
    ).toEqual(["agent", "user", "board"]);
    expect(view.textContent).toContain("Riley Board (you)");
    expect(view.textContent).toContain("Board escalation");
  });

  it("wires owner-change confirmation", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const copy = describeOwnerChangeInterrupt({
      runningAgentName: "ClaudeCoder",
    });
    const view = mount(
      <>
        <OwnerRunningBanner copy={copy} />
        <InterruptOwnerChangeConfirm
          copy={copy}
          to={{
            ownerKind: "agent",
            ownerAgentId: "agent-qa",
            ownerUserId: null,
          }}
          resolvers={resolvers}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </>,
    );
    view.querySelector<HTMLButtonElement>("[data-testid='interrupt-owner-change-confirm-action']")!.click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(view.textContent).toContain("Run active");
  });

  it("keeps compact owner-change warnings readable and actionable", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const copy = describeOwnerChangeInterrupt({ runningAgentName: "ClaudeCoder" });
    const view = mount(
      <>
        <OwnerRunningBanner copy={copy} compact />
        <InterruptOwnerChangeConfirm
          copy={copy}
          to={{ ownerKind: "agent", ownerAgentId: "agent-qa", ownerUserId: null }}
          resolvers={resolvers}
          onConfirm={onConfirm}
          onCancel={onCancel}
          compact
        />
      </>,
    );

    expect(view.querySelector("[data-testid='owner-running-banner']")?.textContent).not.toContain(
      "Run active",
    );
    view.querySelector<HTMLButtonElement>("[data-testid='interrupt-owner-change-confirm-action']")!.click();
    [...view.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === copy.cancelAction)!
      .click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows the empty pause state", () => {
    const view = mount(<PauseAffectsSummaryView summary={computePauseAffectsSummary([{ activeRun: null }])} />);
    expect(view.textContent).toContain("Nothing live to pause");
  });
});
