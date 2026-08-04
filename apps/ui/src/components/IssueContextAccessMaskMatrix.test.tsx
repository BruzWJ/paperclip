// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueContextAccessMaskMatrix } from "./IssueContextAccessMaskMatrix";

(globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueContextAccessMaskMatrix", () => {
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
  });

  it("emits only sparse false cells and collapses identity to null", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <IssueContextAccessMaskMatrix value={null} onChange={onChange} />,
      );
    });
    const identity = container.querySelector<HTMLButtonElement>(
      '[aria-label="Current issue Content: unchanged"]',
    );
    expect(identity).not.toBeNull();
    act(() => identity!.click());
    expect(onChange).toHaveBeenLastCalledWith({ carry_context: false });

    act(() => {
      root.render(
        <IssueContextAccessMaskMatrix
          value={{ carry_context: false }}
          onChange={onChange}
        />,
      );
    });
    const narrowed = container.querySelector<HTMLButtonElement>(
      '[aria-label="Current issue Content: narrowed"]',
    );
    act(() => narrowed!.click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("renders all nine cells and prevents read-only edits", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <IssueContextAccessMaskMatrix
          value={{ read_company_issue_agent_run: false }}
          onChange={onChange}
          readOnly
        />,
      );
    });
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(9);
    const narrowed = container.querySelector<HTMLButtonElement>(
      '[aria-label="Company issues Agent runs: narrowed"]',
    );
    act(() => narrowed!.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops raw true cells before emitting a changed mask", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <IssueContextAccessMaskMatrix
          value={{
            carry_context: true,
            read_issue_comments: false,
          } as unknown as Parameters<
            typeof IssueContextAccessMaskMatrix
          >[0]["value"]}
          onChange={onChange}
        />,
      );
    });
    const runCell = container.querySelector<HTMLButtonElement>(
      '[aria-label="Current issue Agent runs: unchanged"]',
    );
    act(() => runCell!.click());
    expect(onChange).toHaveBeenLastCalledWith({
      read_issue_comments: false,
      read_issue_agent_run: false,
    });
  });
});
