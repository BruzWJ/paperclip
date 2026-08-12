import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfigFile: vi.fn(),
}));

vi.mock("../config-file.js", () => ({
  readConfigFile: mocks.readConfigFile,
}));

vi.mock("@paperclipai/db", () => ({
  resolveDatabaseTarget: vi.fn(() => ({
    connectionString: "postgresql://paperclip.invalid/paperclip",
    source: "environment",
  })),
  resolveOptionalExternalPostgresConnectionString: vi.fn(
    (value: string | undefined) => value,
  ),
}));

import { loadConfig } from "../config.js";

const originalEnvironment = { ...process.env };

describe("canonical bind-host environment", () => {
  beforeEach(() => {
    process.env = {};
    mocks.readConfigFile.mockReturnValue(null);
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it.each(["", " ", " 192.0.2.10", "192.0.2.10 "])(
    "rejects non-canonical PAPERCLIP_BIND_HOST=%j instead of using persisted config",
    (value) => {
      process.env.PAPERCLIP_BIND_HOST = value;
      mocks.readConfigFile.mockReturnValue({
        server: {
          exposure: "private",
          bind: "custom",
          customBindHost: "192.0.2.20",
        },
      });

      expect(() => loadConfig()).toThrow(/PAPERCLIP_BIND_HOST/);
    },
  );

  it.each(["", " ", " 100.64.0.8", "100.64.0.8 "])(
    "rejects non-canonical PAPERCLIP_TAILNET_BIND_HOST=%j instead of auto-detecting",
    (value) => {
      process.env.PAPERCLIP_BIND = "tailnet";
      process.env.PAPERCLIP_TAILNET_BIND_HOST = value;

      expect(() => loadConfig()).toThrow(/PAPERCLIP_TAILNET_BIND_HOST/);
    },
  );

  it("uses exact custom and tailnet host values without normalization", () => {
    process.env.PAPERCLIP_BIND = "custom";
    process.env.PAPERCLIP_BIND_HOST = "192.0.2.10";
    expect(loadConfig()).toMatchObject({
      bind: "custom",
      host: "192.0.2.10",
      customBindHost: "192.0.2.10",
    });

    process.env.PAPERCLIP_BIND = "tailnet";
    delete process.env.PAPERCLIP_BIND_HOST;
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";
    expect(loadConfig()).toMatchObject({
      bind: "tailnet",
      host: "100.64.0.8",
      customBindHost: undefined,
    });
  });

  it.each([
    "",
    "paperclip.test, paperclip.lan",
    "Paperclip.test",
    "paperclip.test,paperclip.test",
    "https://paperclip.test",
  ])("rejects non-canonical PAPERCLIP_ALLOWED_HOSTNAMES=%j", (value) => {
    process.env.PAPERCLIP_ALLOWED_HOSTNAMES = value;
    expect(() => loadConfig()).toThrow(/hostname|duplicates/i);
  });

  it("uses the exact allowed-hostname list without normalization", () => {
    process.env.PAPERCLIP_ALLOWED_HOSTNAMES = "paperclip.test,192.0.2.10";
    expect(loadConfig().allowedHostnames).toEqual([
      "paperclip.test",
      "192.0.2.10",
    ]);
  });
});
