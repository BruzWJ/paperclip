// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentIconPicker } from "./-AgentIconPicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  flushSync(() => {});
}

async function clickTrigger(trigger: HTMLButtonElement) {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await flushReact();
}

describe("AgentIconPicker", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(0), 0);
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("targets cmdk's inner list sizer for the icon grid", async () => {
    flushSync(() => root!.render(<AgentIconPicker value="bot" onChange={() => undefined} />));
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change agent icon"]',
    );

    expect(trigger).not.toBeNull();
    await clickTrigger(trigger!);

    const list = document.querySelector<HTMLElement>('[data-slot="command-list"]');
    const sizer = list?.querySelector<HTMLElement>("[cmdk-list-sizer]");
    const directItems = Array.from(sizer?.children ?? []).filter((child) =>
      child.matches('[data-slot="command-item"]'),
    );

    expect(list?.className).toContain("[&_[cmdk-list-sizer]]:grid");
    expect(list?.className).toContain("[&_[cmdk-list-sizer]]:grid-cols-7");
    expect(directItems.length).toBeGreaterThan(7);
  });
});
