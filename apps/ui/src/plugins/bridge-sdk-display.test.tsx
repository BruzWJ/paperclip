// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PluginSdkDataTable } from "./bridge-sdk-display";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginSdkDataTable", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("adapts plugin columns and custom cells to Kibo's table", () => {
    flushSync(() =>
      root!.render(
        <PluginSdkDataTable
          columns={[
            { key: "name", header: "Name", sortable: true },
            {
              key: "count",
              header: "Count",
              render: (value) => <strong>{String(value)}</strong>,
            },
          ]}
          rows={[
            { id: "one", name: "First", count: 1 },
            { id: "two", name: "Second", count: 2 },
          ]}
        />,
      ),
    );

    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.textContent).toContain("First");
    expect(container.querySelector("strong")?.textContent).toBe("1");
  });
});
