import { describe, expect, it, vi } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  createPluginHostServicesTestOptions,
  createPluginManifestFake,
  noopPluginEventDelivery,
} from "./helpers/plugin-host-services.js";

const mocks = vi.hoisted(() => ({
  logActivity: vi.fn(async () => undefined),
  assertInstallationScope: vi.fn(async () => undefined),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

vi.mock("../services/plugin-task-authorization.js", async () => {
  const actual = await vi.importActual<typeof import("../services/plugin-task-authorization.js")>(
    "../services/plugin-task-authorization.js",
  );
  return {
    ...actual,
    assertPluginInstallationRequestScope: mocks.assertInstallationScope,
  };
});

describe("plugin activity host service", () => {
  it("stores plugin text as details under one fixed activity action", async () => {
    const pluginKey = "paperclip.activity-test";
    const pluginId = "00000000-0000-4000-8000-000000000001";
    const companyId = "00000000-0000-4000-8000-000000000002";
    const services = buildHostServices(
      {} as never,
      pluginId,
      {
        forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
      } as never,
      noopPluginEventDelivery,
      createPluginHostServicesTestOptions({
        manifest: createPluginManifestFake({ id: pluginKey }),
      }),
    );

    await services.activity.log({
      companyId,
      message: "task.created",
      entityType: "task",
      entityId: "task-1",
      metadata: { source: "test" },
    });

    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "plugin",
        actorId: pluginId,
        action: "activity.logged",
        entityType: "task",
        entityId: "task-1",
        details: expect.objectContaining({
          message: "task.created",
          source: "test",
          sourcePluginId: pluginId,
          sourcePluginKey: pluginKey,
        }),
      }),
    );
  });
});
