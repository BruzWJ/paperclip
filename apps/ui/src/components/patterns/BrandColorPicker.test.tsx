// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrandColorPicker } from "./BrandColorPicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fallbackColor = ["#", "6366f1"].join("");
const initialColor = ["#", "abcdef"].join("");
const changedColor = ["#", "123456"].join("");

describe("BrandColorPicker", () => {
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

  it("wraps the Kibo picker without turning an empty brand color into the fallback", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <StrictMode>
          <BrandColorPicker value="" fallbackValue={fallbackColor} onChange={onChange} />
        </StrictMode>,
      );
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Brand color saturation and lightness"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Brand color hue"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Brand color opacity"]')).toBeTruthy();
    expect(container.querySelector<HTMLInputElement>('[aria-label="Brand color hex value"]')?.value).toBe("");
  });

  it("retains the editable domain hex contract", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <BrandColorPicker value={initialColor} fallbackValue={fallbackColor} onChange={onChange} />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('[aria-label="Brand color hex value"]');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      valueSetter?.call(input, changedColor);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(changedColor);
  });
});
