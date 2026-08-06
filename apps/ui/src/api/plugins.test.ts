import type {
  PluginConfigDto,
  PluginDetailDto,
  PluginLogDto,
  PluginRecordDto,
} from "@paperclipai/shared";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { pluginsApi } from "./plugins";

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";

describe("pluginsApi installation", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({});
  });

  it("uses the one query-free uninstall endpoint", async () => {
    mockApi.delete.mockResolvedValue(undefined);

    await pluginsApi.uninstall(PLUGIN_ID);

    expect(mockApi.delete).toHaveBeenCalledWith(`/plugins/${PLUGIN_ID}`);
  });

  it("sends the exact npm install union member", async () => {
    await pluginsApi.install({
      source: "npm",
      packageName: "@acme/plugin-linear",
      version: "1.2.3",
    });

    expect(mockApi.post).toHaveBeenCalledWith("/plugins/install", {
      source: "npm",
      packageName: "@acme/plugin-linear",
      version: "1.2.3",
    });
  });

  it("sends the exact local install union member", async () => {
    await pluginsApi.install({ source: "local", path: "/plugins/acme-linear" });

    expect(mockApi.post).toHaveBeenCalledWith("/plugins/install", {
      source: "local",
      path: "/plugins/acme-linear",
    });
  });

  it("exposes serialized installation, detail, and log response contracts", () => {
    expectTypeOf(pluginsApi.list()).toEqualTypeOf<Promise<PluginRecordDto[]>>();
    expectTypeOf(pluginsApi.get(PLUGIN_ID)).toEqualTypeOf<Promise<PluginDetailDto>>();
    expectTypeOf(pluginsApi.logs(PLUGIN_ID)).toEqualTypeOf<Promise<PluginLogDto[]>>();
  });
});

describe("pluginsApi instance configuration", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.put.mockReset();
    mockApi.get.mockResolvedValue({});
    mockApi.post.mockResolvedValue({});
  });

  it("gets configuration without company scope", async () => {
    await pluginsApi.getConfig(PLUGIN_ID);

    expect(mockApi.get).toHaveBeenCalledWith(`/plugins/${PLUGIN_ID}/config`);
  });

  it("exposes the serialized configuration response contract", () => {
    expectTypeOf(pluginsApi.getConfig(PLUGIN_ID)).toEqualTypeOf<
      Promise<PluginConfigDto | null>
    >();
  });

  it("saves configuration without a company id", async () => {
    await pluginsApi.saveConfig(PLUGIN_ID, { baseUrl: "https://connector.example" });

    expect(mockApi.post).toHaveBeenCalledWith(`/plugins/${PLUGIN_ID}/config`, {
      configJson: { baseUrl: "https://connector.example" },
    });
  });

  it("tests configuration without a company id", async () => {
    await pluginsApi.testConfig(PLUGIN_ID, { baseUrl: "https://connector.example" });

    expect(mockApi.post).toHaveBeenCalledWith(`/plugins/${PLUGIN_ID}/config/test`, {
      configJson: { baseUrl: "https://connector.example" },
    });
  });
});

describe("pluginsApi local folders", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.put.mockReset();
    mockApi.get.mockResolvedValue({});
    mockApi.post.mockResolvedValue({});
    mockApi.put.mockResolvedValue({});
  });

  it("lists company-scoped local folders for a plugin", async () => {
    await pluginsApi.listLocalFolders(PLUGIN_ID, "company-1");

    expect(mockApi.get).toHaveBeenCalledWith(
      `/plugins/${PLUGIN_ID}/companies/company-1/local-folders`,
    );
  });

  it("validates a candidate folder path without saving", async () => {
    await pluginsApi.validateLocalFolder(PLUGIN_ID, "company-1", "content-root", {
      path: "/tmp/content",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      `/plugins/${PLUGIN_ID}/companies/company-1/local-folders/content-root/validate`,
      {
        path: "/tmp/content",
      },
    );
  });

  it("saves through the local-folder PUT endpoint", async () => {
    await pluginsApi.configureLocalFolder(PLUGIN_ID, "company-1", "content-root", {
      path: "/tmp/content",
    });

    expect(mockApi.put).toHaveBeenCalledWith(
      `/plugins/${PLUGIN_ID}/companies/company-1/local-folders/content-root`,
      {
        path: "/tmp/content",
      },
    );
  });
});
