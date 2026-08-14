// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DomainTree } from "./DomainTree";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("DomainTree", () => {
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

  it("leaves keyboard events from nested controls with those controls", () => {
    const onActivate = vi.fn();
    const onNodeKeyDown = vi.fn();

    act(() => {
      root.render(
        <DomainTree
          ariaLabel="Nested controls"
          nodes={[
            { id: "first", value: "First" },
            { id: "second", value: "Second" },
          ]}
          onActivate={onActivate}
          onNodeKeyDown={onNodeKeyDown}
          renderLabel={({ node }) =>
            node.id === "first" ? <button type="button">Nested action</button> : node.value
          }
        />,
      );
    });

    const nestedAction = container.querySelector("button");
    expect(nestedAction).not.toBeNull();

    act(() => {
      nestedAction?.focus();
      nestedAction?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      nestedAction?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      nestedAction?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

    expect(onActivate).not.toHaveBeenCalled();
    expect(onNodeKeyDown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(nestedAction);
  });
});
