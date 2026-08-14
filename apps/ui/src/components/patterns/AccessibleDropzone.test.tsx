// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessibleDropzone } from "./AccessibleDropzone";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AccessibleDropzone", () => {
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
    vi.restoreAllMocks();
  });

  it("uses one named keyboard-operable root without nesting the file input in a native button", () => {
    act(() => {
      root.render(<AccessibleDropzone ariaLabel="Upload company logo" maxFiles={1} />);
    });

    const dropzone = container.querySelector<HTMLElement>('[data-slot="dropzone"]');
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    expect(dropzone?.tagName).toBe("DIV");
    expect(dropzone?.getAttribute("role")).toBe("button");
    expect(dropzone?.getAttribute("aria-label")).toBe("Upload company logo");
    expect(dropzone?.tabIndex).toBe(0);
    expect(input?.getAttribute("aria-label")).toBe("Upload company logo");
    expect(input?.closest("button")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("retains the Kibo default empty and selected-file presentation", () => {
    const file = new File(["package"], "paperclip-company.zip", { type: "application/zip" });

    act(() => {
      root.render(
        <AccessibleDropzone
          accept={{ "application/zip": [".zip"] }}
          ariaLabel="Upload company package"
          maxFiles={1}
        />,
      );
    });

    expect(container.textContent).toContain("Upload a file");
    expect(container.textContent).toContain("Drag and drop or click to upload");
    expect(container.textContent).toContain("Accepts application/zip.");

    act(() => {
      root.render(
        <AccessibleDropzone
          accept={{ "application/zip": [".zip"] }}
          ariaLabel="Upload company package"
          maxFiles={1}
          src={[file]}
        />,
      );
    });

    expect(container.textContent).toContain("paperclip-company.zip");
    expect(container.textContent).toContain("Drag and drop or click to replace");
    expect(container.textContent).not.toContain("Upload a file");
  });

  it("opens the native file picker from the keyboard", () => {
    act(() => {
      root.render(<AccessibleDropzone ariaLabel="Upload company logo" />);
    });

    const dropzone = container.querySelector<HTMLElement>('[data-slot="dropzone"]');
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const inputClick = vi.spyOn(input!, "click").mockImplementation(() => undefined);

    act(() => {
      dropzone?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });

    expect(inputClick).toHaveBeenCalledOnce();
  });

  it("removes the disabled dropzone from the tab order", () => {
    act(() => {
      root.render(<AccessibleDropzone ariaLabel="Upload company logo" disabled />);
    });

    const dropzone = container.querySelector<HTMLElement>('[data-slot="dropzone"]');
    expect(dropzone?.getAttribute("aria-disabled")).toBe("true");
    expect(dropzone?.hasAttribute("tabindex")).toBe(false);
  });
});
