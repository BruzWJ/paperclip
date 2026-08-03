// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposerMentionCoach,
  ComposerOwnerPreviewRow,
  InterruptOwnerChangeConfirm,
  OwnerChip,
  OwnerRunningBanner,
  OwnerDispatchRow,
  PauseAffectsSummaryView,
  RunStatusBadge,
  type OwnerChipResolvers,
} from "./OwnerTransitionViews";
import {
  computeComposerOwnerPreview,
  computePauseAffectsSummary,
  describeOwnerChangeInterrupt,
} from "../../lib/owner-transition";

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
        <OwnerChip owner={{ ownerKind: "agent", ownerAgentId: "agent-qa", ownerUserId: null }} resolvers={resolvers} />
        <OwnerChip owner={{ ownerKind: "user", ownerAgentId: null, ownerUserId: "user-board" }} resolvers={resolvers} />
        <OwnerChip owner={{ ownerKind: "board", ownerAgentId: null, ownerUserId: null }} resolvers={resolvers} />
      </>,
    );
    expect([...view.querySelectorAll("[data-testid='owner-chip']")].map((chip) => chip.getAttribute("data-kind")))
      .toEqual(["agent", "user", "board"]);
    expect(view.textContent).toContain("Riley Board (you)");
    expect(view.textContent).toContain("Board escalation");
  });

  it("renders the agent dispatch and interrupt preview", () => {
    const preview = computeComposerOwnerPreview({
      ownerTarget: "agent:agent-qa",
      currentOwnerValue: "agent:agent-coder",
      hasActiveRun: true,
      bodyHasAgentMention: false,
    });
    const view = mount(
      <>
        <OwnerDispatchRow
          to={{ ownerKind: "agent", ownerAgentId: "agent-qa", ownerUserId: null }}
          resolvers={resolvers}
          interruptedRunAttached
        />
        <ComposerOwnerPreviewRow preview={preview} resolvers={resolvers} />
      </>,
    );
    expect(view.textContent).toContain("queued for QA");
    expect(view.textContent).toContain("Interrupt current run and change owner to");
  });

  it("wires mention coaching and owner-change confirmation", () => {
    const onInsert = vi.fn();
    const onDismiss = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const copy = describeOwnerChangeInterrupt({ runningAgentName: "ClaudeCoder" });
    const view = mount(
      <>
        <ComposerMentionCoach
          candidate={{ agentId: "agent-qa", matchedText: "QA" }}
          agentDisplayName="QA"
          onInsert={onInsert}
          onDismiss={onDismiss}
        />
        <OwnerRunningBanner copy={copy} />
        <InterruptOwnerChangeConfirm
          copy={copy}
          to={{ ownerKind: "agent", ownerAgentId: "agent-qa", ownerUserId: null }}
          resolvers={resolvers}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </>,
    );
    view.querySelector<HTMLButtonElement>("[aria-label^='Insert mention for QA']")!.click();
    view.querySelector<HTMLButtonElement>("[aria-label='Dismiss suggestion']")!.click();
    view.querySelector<HTMLButtonElement>("[data-testid='interrupt-owner-change-confirm-action']")!.click();
    expect(onInsert).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("shows run and pause status without legacy singleton state", () => {
    const view = mount(
      <>
        <RunStatusBadge status="cancelled" operatorInterrupted />
        <PauseAffectsSummaryView summary={computePauseAffectsSummary([{ activeRun: null }])} />
      </>,
    );
    expect(view.textContent).toContain("interrupted");
    expect(view.textContent).toContain("Nothing live to pause");
  });
});
