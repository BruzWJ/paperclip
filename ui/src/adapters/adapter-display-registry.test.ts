import { describe, expect, it } from "vitest";

import {
  getAdapterDisplay,
  getAdapterLabel,
} from "./adapter-display-registry";

describe("adapter display registry", () => {
  it("derives neutral presentation for a server-admitted catalog name", () => {
    expect(getAdapterLabel("fixture_acp")).toBe("Fixture Acp");
    const display = getAdapterDisplay("fixture_acp");
    expect(display).toMatchObject({
      label: "Fixture Acp",
      description: "Discovered from ACPX at runtime",
    });
    expect(display).not.toHaveProperty("icon");
  });
});
