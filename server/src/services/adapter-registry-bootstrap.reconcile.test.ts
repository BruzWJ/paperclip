import { describe, expect, it, vi } from "vitest";

const setAdapterDisabled = vi.fn();

vi.mock("../adapters/registry.js", async (orig) => ({
  ...(await orig()),
  listServerAdapters: () => [
    { type: "codex" },
    { type: "external_test" },
  ],
}));

vi.mock("./adapter-plugin-store.js", () => ({
  listAdapterPlugins: () => [],
  setAdapterDisabled: (type: string, disabled: boolean) => setAdapterDisabled(type, disabled),
}));

const { reconcileAdapterAvailability } = await import("./adapter-registry-bootstrap.js");

describe("reconcileAdapterAvailability", () => {
  it("is a no-op when registry is null", () => {
    setAdapterDisabled.mockReset();
    expect(reconcileAdapterAvailability(null)).toEqual({ enabled: [], disabled: [] });
    expect(setAdapterDisabled).not.toHaveBeenCalled();
  });

  it("enables declared adapters and disables the rest", () => {
    setAdapterDisabled.mockReset();
    const result = reconcileAdapterAvailability([
      { adapterType: "codex", enabled: true },
    ]);
    expect(result.enabled).toEqual(["codex"]);
    expect(result.disabled).toEqual(["external_test"]);
    expect(setAdapterDisabled).toHaveBeenCalledWith("external_test", true);
    expect(setAdapterDisabled).toHaveBeenCalledWith("codex", false);
  });

  it("throws when a declared adapter has no installed implementation", () => {
    setAdapterDisabled.mockReset();
    expect(() =>
      reconcileAdapterAvailability([{ adapterType: "ghost_adapter", enabled: true }]),
    ).toThrow(/no installed adapter: ghost_adapter/);
  });
});
