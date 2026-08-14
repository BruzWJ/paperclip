// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataTable, DataTableColumnHeader, type ColumnDef } from "./DataTable";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ExampleRow = {
  id: string;
  name: string;
  count: number;
};

const columns: ColumnDef<ExampleRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
  },
  {
    accessorKey: "count",
    header: "Count",
  },
];

function pointerClick(element: Element) {
  element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  (element as HTMLElement).click();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("DataTable", () => {
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

  it("renders typed columns and cells through Kibo's table shell", () => {
    flushSync(() =>
      root!.render(
        <DataTable
          caption="Examples"
          columns={columns}
          data={[
            { id: "one", name: "First", count: 1 },
            { id: "two", name: "Second", count: 2 },
          ]}
        />,
      ),
    );

    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("caption")?.textContent).toBe("Examples");
    expect(container.textContent).toContain("First");
    expect(container.textContent).toContain("Second");
  });

  it("uses Kibo's no-results row for empty datasets", () => {
    flushSync(() => root!.render(<DataTable columns={columns} data={[]} />));

    expect(container.textContent).toContain("No results.");
    expect(container.querySelector("tbody td")?.getAttribute("colspan")).toBe("2");
  });

  it("can omit the header for key-value tables", () => {
    flushSync(() =>
      root!.render(
        <DataTable columns={columns} data={[{ id: "one", name: "First", count: 1 }]} showHeader={false} />,
      ),
    );

    expect(container.querySelector("thead")).toBeNull();
    expect(container.textContent).toContain("First");
  });

  it("delegates sortable headers and row ordering to Kibo", async () => {
    flushSync(() =>
      root!.render(
        <DataTable
          columns={columns}
          data={[
            { id: "two", name: "Second", count: 2 },
            { id: "one", name: "First", count: 1 },
          ]}
        />,
      ),
    );

    const nameHeader = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Name",
    );
    expect(nameHeader).toBeTruthy();
    act(() => pointerClick(nameHeader!));
    await flush();
    const ascending = Array.from(document.querySelectorAll("[data-slot='dropdown-menu-item']")).find(
      (item) => item.textContent === "Asc",
    );
    expect(ascending).toBeTruthy();
    act(() => pointerClick(ascending!));
    await flush();

    expect(container.querySelector("tbody tr:first-child")?.textContent).toContain("First");
  });
});
