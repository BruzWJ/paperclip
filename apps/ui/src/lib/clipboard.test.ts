import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyTextToClipboard", () => {
  it("uses the Clipboard API", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await copyTextToClipboard("ssh agent@host");

    expect(writeText).toHaveBeenCalledWith("ssh agent@host");
  });

  it("throws when the Clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyTextToClipboard("x")).rejects.toThrow("Clipboard unavailable");
  });
});
