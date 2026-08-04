// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { IssueOwnerBacklogNotice } from "./IssueOwnerBacklogNotice";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseAgent = {
  id: "agent-1",
  companyId: "co-1",
  name: "ClaudeCoder",
  status: "active",
} as unknown as Agent;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("IssueOwnerBacklogNotice", () => {
  it("renders nothing when status is not backlog", () => {
    act(() => {
      root.render(
        <IssueOwnerBacklogNotice
          issueStatus="todo"
          ownerAgent={baseAgent}
          ownerUserId={null}
        />,
      );
    });
    expect(container.querySelector('[data-testid="issue-owner-backlog-notice"]')).toBeNull();
  });

  it("renders nothing when there is no owner", () => {
    act(() => {
      root.render(
        <IssueOwnerBacklogNotice
          issueStatus="backlog"
          ownerAgent={null}
          ownerUserId={null}
        />,
      );
    });
    expect(container.querySelector('[data-testid="issue-owner-backlog-notice"]')).toBeNull();
  });

  it("warns when an agent owns an issue parked in backlog", () => {
    act(() => {
      root.render(
        <IssueOwnerBacklogNotice
          issueStatus="backlog"
          ownerAgent={baseAgent}
          ownerUserId={null}
        />,
      );
    });
    const notice = container.querySelector('[data-testid="issue-owner-backlog-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Parked");
    expect(notice?.textContent).toContain("ClaudeCoder");
  });

  it("calls onResume when the resume button is clicked", () => {
    const onResume = vi.fn();
    act(() => {
      root.render(
        <IssueOwnerBacklogNotice
          issueStatus="backlog"
          ownerAgent={baseAgent}
          ownerUserId={null}
          onResume={onResume}
        />,
      );
    });
    const button = container.querySelector('[data-testid="issue-owner-backlog-resume"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    act(() => {
      button?.click();
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("disables the resume button while resuming", () => {
    act(() => {
      root.render(
        <IssueOwnerBacklogNotice
          issueStatus="backlog"
          ownerAgent={baseAgent}
          ownerUserId={null}
          onResume={() => undefined}
          resuming
        />,
      );
    });
    const button = container.querySelector('[data-testid="issue-owner-backlog-resume"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Resuming");
  });
});
