// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainStatus } from "./DomainStatus";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DomainStatus", () => {
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

  it("maps Paperclip status groups onto Kibo status tones", () => {
    act(() => {
      root.render(
        <>
          <DomainStatus status="failed" />
          <DomainStatus status="pending_approval" />
          <DomainStatus status="draft" />
          <DomainStatus status="running" />
          <DomainStatus status="future_state" />
        </>,
      );
    });

    expect(container.querySelector(".offline")?.textContent).toContain("failed");
    expect(container.querySelector(".degraded")?.textContent).toContain("pending approval");
    expect(container.querySelector(".maintenance")?.textContent).toContain("draft");
    expect(container.querySelector(".online")?.textContent).toContain("running");
    expect(Array.from(container.querySelectorAll(".maintenance")).at(-1)?.textContent).toContain(
      "future state",
    );
  });

  it("preserves a domain-specific visible label and accessible name", () => {
    act(() => {
      root.render(
        <DomainStatus status="todo" aria-label="Task status: To do">
          To do
        </DomainStatus>,
      );
    });

    const status = container.querySelector('[aria-label="Task status: To do"]');
    expect(status?.textContent).toContain("To do");
    expect(status?.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it("suppresses its decorative pulse when reduced motion is requested", () => {
    act(() => {
      root.render(<DomainStatus status="running" />);
    });

    expect(container.querySelector(".animate-ping")?.classList.contains("motion-reduce:animate-none")).toBe(
      true,
    );
  });
});
