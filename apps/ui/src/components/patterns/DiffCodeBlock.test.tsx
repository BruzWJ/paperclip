// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiffCodeBlock } from "./DiffCodeBlock";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function waitForHighlight(container: HTMLElement) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (container.querySelector(".shiki")) return;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
  throw new Error("Kibo code highlighting did not finish");
}

describe("DiffCodeBlock", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("renders additions and removals through Kibo's notation diff", async () => {
    flushSync(() =>
      root!.render(<DiffCodeBlock oldText={"same\nold"} newText={"same\nnew"} filename="sample.txt" />),
    );
    await waitForHighlight(container);

    expect(container.querySelector("[data-slot='diff-code-block']")).not.toBeNull();
    expect(container.querySelector(".line.diff.remove")?.textContent).toBe("- old");
    expect(container.querySelector(".line.diff.add")?.textContent).toBe("+ new");
    expect(container.textContent).not.toContain("[!code");
  });

  it("treats an empty old value as a full insertion", async () => {
    flushSync(() =>
      root!.render(<DiffCodeBlock oldText="" newText={"first\nsecond"} filename="sample.txt" />),
    );
    await waitForHighlight(container);

    expect(container.querySelectorAll(".line.diff.add")).toHaveLength(2);
    expect(container.querySelector(".line.diff.remove")).toBeNull();
  });

  it("uses the supplied empty message when neither side has content", () => {
    flushSync(() =>
      root!.render(
        <DiffCodeBlock oldText="" newText="" emptyMessage="Nothing saved yet." filename="sample.txt" />,
      ),
    );

    expect(container.textContent).toContain("Nothing saved yet.");
    expect(container.querySelector("[data-slot='diff-code-block']")).toBeNull();
  });

  it("uses the supplied identical message for unchanged content", () => {
    flushSync(() =>
      root!.render(
        <DiffCodeBlock
          oldText="unchanged"
          newText="unchanged"
          identicalMessage="No changes."
          filename="sample.txt"
        />,
      ),
    );

    expect(container.textContent).toContain("No changes.");
    expect(container.querySelector("[data-slot='diff-code-block']")).toBeNull();
  });
});
