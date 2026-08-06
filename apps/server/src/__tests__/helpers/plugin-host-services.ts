import type { HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type {
  PluginHostServicesOptions,
  PluginIssueControlPlane,
  PluginRunIssueContextReader,
  PluginRuntimeRecordsReader,
} from "../../services/plugin-host-services.js";

function unexpectedHostCall(name: string): Promise<never> {
  return Promise.reject(new Error(`Unexpected plugin host test call: ${name}`));
}

export function createPluginIssueControlPlaneFake(
  overrides: Partial<PluginIssueControlPlane> = {},
): PluginIssueControlPlane {
  return {
    list: () => unexpectedHostCall("issues.list"),
    get: () => unexpectedHostCall("issues.get"),
    create: () => unexpectedHostCall("issues.create"),
    update: () => unexpectedHostCall("issues.update"),
    withdraw: () => unexpectedHostCall("issues.withdraw"),
    ...overrides,
  };
}

export function createPluginRunIssueContextReaderFake(
  overrides: Partial<PluginRunIssueContextReader> = {},
): PluginRunIssueContextReader {
  return {
    resolveContext: () => unexpectedHostCall("run.context.resolve"),
    issueReach: () => unexpectedHostCall("run.context.issueReach"),
    listCompanyIssues: () => unexpectedHostCall("run.issues.listCompanyIssues"),
    listSubIssues: () => unexpectedHostCall("run.issues.listSubIssues"),
    readIssueComments: () => unexpectedHostCall("run.issues.readIssueComments"),
    readIssueAgentRun: () => unexpectedHostCall("run.issues.readIssueAgentRun"),
    ...overrides,
  };
}

export function createPluginRuntimeRecordsReaderFake(
  overrides: Partial<PluginRuntimeRecordsReader> = {},
): PluginRuntimeRecordsReader {
  return {
    readSession: () => unexpectedHostCall("runtime.records.readSession"),
    readRun: () => unexpectedHostCall("runtime.records.readRun"),
    readIssueComments: () => unexpectedHostCall("runtime.records.readIssueComments"),
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
    pluginIssueControlPlane: createPluginIssueControlPlaneFake(),
    pluginRunIssueContextReader: createPluginRunIssueContextReaderFake(),
    pluginRuntimeRecordsReader: createPluginRuntimeRecordsReaderFake(),
    ordinaryIssues: {} as PluginHostServicesOptions["ordinaryIssues"],
    issueExecutionCancellation:
      {} as PluginHostServicesOptions["issueExecutionCancellation"],
    ...overrides,
  };
}

export const noopPluginEventDelivery: (
  params: HostToWorkerMethods["onEvent"][0],
) => Promise<void> = async () => undefined;
