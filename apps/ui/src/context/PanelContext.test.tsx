// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PanelProvider, usePanel } from "./PanelContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function PanelHarness() {
  const { closePanel, openPanel, panelContent, panelHeaderMode, panelTitle } = usePanel();
  return (
    <div>
      <span data-testid="panel-title">{panelTitle}</span>
      <span data-testid="panel-header-mode">{panelHeaderMode}</span>
      <div data-testid="panel-content">{panelContent}</div>
      <button type="button" onClick={() => openPanel(<span>Default content</span>)}>
        Open default
      </button>
      <button
        type="button"
        onClick={() =>
          openPanel(<span>Task content</span>, {
            title: "Task details",
            headerMode: "content",
          })
        }
      >
        Open task
      </button>
      <button type="button" onClick={closePanel}>
        Close
      </button>
    </div>
  );
}

describe("PanelContext", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <PanelProvider>
          <PanelHarness />
        </PanelProvider>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the default Properties title for one-argument callers", () => {
    const buttons = Array.from(container.querySelectorAll("button"));
    act(() => buttons.find((button) => button.textContent === "Open default")?.click());

    expect(container.querySelector('[data-testid="panel-title"]')?.textContent).toBe("Properties");
    expect(container.querySelector('[data-testid="panel-header-mode"]')?.textContent).toBe("shell");
    expect(container.querySelector('[data-testid="panel-content"]')?.textContent).toBe("Default content");
  });

  it("publishes a content-owned header atomically and resets it when closed", () => {
    const buttons = Array.from(container.querySelectorAll("button"));
    act(() => buttons.find((button) => button.textContent === "Open task")?.click());

    expect(container.querySelector('[data-testid="panel-title"]')?.textContent).toBe("Task details");
    expect(container.querySelector('[data-testid="panel-header-mode"]')?.textContent).toBe("content");
    expect(container.querySelector('[data-testid="panel-content"]')?.textContent).toBe("Task content");

    act(() => buttons.find((button) => button.textContent === "Close")?.click());
    expect(container.querySelector('[data-testid="panel-title"]')?.textContent).toBe("Properties");
    expect(container.querySelector('[data-testid="panel-header-mode"]')?.textContent).toBe("shell");
    expect(container.querySelector('[data-testid="panel-content"]')?.textContent).toBe("");
  });
});
