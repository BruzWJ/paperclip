// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@paperclipai/shared";

const COMPANY_ID = vi.hoisted(() => "11111111-1111-4111-8111-111111111111");

vi.mock("@/hooks/useCompanyRouteId", () => ({
  useCompanyRouteId: () => COMPANY_ID,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { ApprovalCard } from "./-ApprovalCard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const approval: Approval = {
  id: "approval-1",
  companyId: COMPANY_ID,
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
  return [...document.body.querySelectorAll("button")].find(
    (button) => (button.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | null;
}

describe("ApprovalCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("requires confirmation before rejecting an approval", async () => {
    const onReject = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalCard approval={approval} requesterAgent={null} onApprove={vi.fn()} onReject={onReject} />,
      );
    });

    act(() => {
      findButton("Reject")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onReject).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Reject this approval?");

    await act(async () => {
      findButton("Reject approval")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(onReject).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull();

    act(() => root.unmount());
  });
});
