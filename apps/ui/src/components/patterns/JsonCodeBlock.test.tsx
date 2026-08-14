// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { JsonCodeBlock } from "./JsonCodeBlock";

describe("JsonCodeBlock", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("serializes data and delegates copy behavior to the Kibo code block", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    flushSync(() => {
      root.render(<JsonCodeBlock filename="payload.json" value={{ ok: true }} />);
    });

    expect(container.textContent).toContain("payload.json");
    expect(container.textContent).toContain('"ok"');

    const copyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy payload.json"]');
    expect(copyButton).not.toBeNull();

    flushSync(() => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(writeText).toHaveBeenCalledWith('{\n  "ok": true\n}');
  });
});
