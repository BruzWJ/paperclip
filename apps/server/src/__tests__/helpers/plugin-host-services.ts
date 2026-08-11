import type { HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type {
  PluginHostServicesOptions,
  PluginTaskControlPlane,
  PluginRunTaskContextReader,
  PluginRuntimeRecordsReader,
} from "../../services/plugin-host-services.js";

function unexpectedHostCall(name: string): Promise<never> {
  return Promise.reject(new Error(`Unexpected plugin host test call: ${name}`));
}

export function createPluginTaskControlPlaneFake(
  overrides: Partial<PluginTaskControlPlane> = {},
): PluginTaskControlPlane {
  return {
    list: () => unexpectedHostCall("tasks.list"),
    get: () => unexpectedHostCall("tasks.get"),
    create: () => unexpectedHostCall("tasks.create"),
    update: () => unexpectedHostCall("tasks.update"),
    withdraw: () => unexpectedHostCall("tasks.withdraw"),
    ...overrides,
  };
}

export function createPluginRunTaskContextReaderFake(
  overrides: Partial<PluginRunTaskContextReader> = {},
): PluginRunTaskContextReader {
  return {
    resolveContext: () => unexpectedHostCall("run.context.resolve"),
    taskReach: () => unexpectedHostCall("run.context.taskReach"),
    listCompanyTasks: () => unexpectedHostCall("run.tasks.listCompanyTasks"),
    listSubTasks: () => unexpectedHostCall("run.tasks.listSubTasks"),
    readTaskComments: () => unexpectedHostCall("run.tasks.readTaskComments"),
    readTaskAgentRun: () => unexpectedHostCall("run.tasks.readTaskAgentRun"),
    ...overrides,
  };
}

export function createPluginRuntimeRecordsReaderFake(
  overrides: Partial<PluginRuntimeRecordsReader> = {},
): PluginRuntimeRecordsReader {
  return {
    readSession: () => unexpectedHostCall("runtime.records.readSession"),
    readRun: () => unexpectedHostCall("runtime.records.readRun"),
    readTaskComments: () => unexpectedHostCall("runtime.records.readTaskComments"),
    ...overrides,
  };
}

export function createPluginManifestFake(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "Explicit plugin host services test fixture.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "./worker.js" },
    ...overrides,
  };
}

export function createPluginHostServicesTestOptions(
  overrides: Partial<PluginHostServicesOptions> = {},
): PluginHostServicesOptions {
  return {
    manifest: createPluginManifestFake(),
    pluginTaskControlPlane: createPluginTaskControlPlaneFake(),
    pluginRunTaskContextReader: createPluginRunTaskContextReaderFake(),
    pluginRuntimeRecordsReader: createPluginRuntimeRecordsReaderFake(),
    ordinaryTasks: {} as PluginHostServicesOptions["ordinaryTasks"],
    taskExecutionCancellation:
      {} as PluginHostServicesOptions["taskExecutionCancellation"],
    ...overrides,
  };
}

export const noopPluginEventDelivery: (
  params: HostToWorkerMethods["onEvent"][0],
) => Promise<void> = async () => undefined;
