// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params: _params,
    children,
    ...props
  }: ComponentProps<"a"> & {
    to: string;
    params?: Record<string, string>;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { TaskChatConfirmation } from "./-TaskChatConfirmation";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseApproval: Approval = {
  id: "approval-1",
  companyId: "11111111-1111-4111-8111-111111111111",
  type: "request_board_approval",
  requestedByAgentId: null,
  requestedByUserId: "user-1",
  status: "pending",
  payload: { title: "Publish the release notes" },
  decisionNote: null,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: new Date("2026-08-03T00:00:00.000Z"),
  updatedAt: new Date("2026-08-03T00:00:00.000Z"),
};

function findButton(label: string): HTMLButtonElement | null {
  return (
    ([...document.body.querySelectorAll("button")].find(
      (button) => (button.textContent ?? "").trim() === label,
    ) as HTMLButtonElement | undefined) ?? null
  );
}

describe("TaskChatConfirmation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("emits the task approval mutation input when approving", () => {
    const onDecision = vi.fn();

    act(() => {
      root.render(<TaskChatConfirmation approval={baseApproval} onDecision={onDecision} />);
    });
    act(() => {
      findButton("Approve")?.click();
    });

    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith({ approvalId: baseApproval.id, action: "approve" });
  });

  it("does not render an empty payload panel when the subject is the only board detail", () => {
    act(() => {
      root.render(<TaskChatConfirmation approval={baseApproval} onDecision={vi.fn()} />);
    });

    expect(container.querySelector('[data-testid="task-chat-approval-payload"]')).toBeNull();
  });

  it("confirms rejection before emitting the mutation input", async () => {
    const onDecision = vi.fn();

    act(() => {
      root.render(<TaskChatConfirmation approval={baseApproval} onDecision={onDecision} />);
    });
    act(() => {
      findButton("Reject")?.click();
    });

    expect(onDecision).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Reject this approval?");

    await act(async () => {
      findButton("Reject approval")?.click();
      await Promise.resolve();
    });

    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith({ approvalId: baseApproval.id, action: "reject" });
  });

  it("routes budget stops to cost controls without exposing decision actions", () => {
    const onDecision = vi.fn();
    const budgetApproval: Approval = {
      ...baseApproval,
      id: "budget-approval-1",
      type: "budget_override_required",
      payload: { reason: "Monthly budget reached" },
    };

    act(() => {
      root.render(<TaskChatConfirmation approval={budgetApproval} onDecision={onDecision} />);
    });

    expect(findButton("Approve")).toBeNull();
    expect(findButton("Reject")).toBeNull();
    expect(document.body.textContent).toContain("Open budget controls");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("renders an approved request as terminal without decision actions", () => {
    const approved: Approval = {
      ...baseApproval,
      status: "approved",
      decisionNote: "Release plan is ready.",
    };

    act(() => {
      root.render(<TaskChatConfirmation approval={approved} onDecision={vi.fn()} />);
    });

    expect(document.body.textContent).toContain("Request approved");
    expect(document.body.textContent).toContain("Release plan is ready.");
    expect(findButton("Approve")).toBeNull();
    expect(findButton("Reject")).toBeNull();
  });
});
