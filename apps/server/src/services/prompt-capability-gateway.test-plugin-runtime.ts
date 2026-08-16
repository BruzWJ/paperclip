import { vi } from "vitest";
import { resolveContextDial } from "./context-dial-resolver.js";
import {
  createPromptCapabilityGateway,
  mintPromptCapabilityBearer,
  type PromptCapabilityGatewayRepository,
} from "./prompt-capability-gateway.js";
import type { RuntimeInterfaceCompileInput } from "./runtime-interface-compiler.js";
import { createRuntimePluginToolPort, createRuntimeToolGateway } from "./runtime-tool-gateway.js";
import { capability, now } from "./prompt-capability-gateway.test-fixtures.js";

export function compileInput(): RuntimeInterfaceCompileInput {
  return {
    mode: "owner" as const,
    turn: "work",
    contextDial: resolveContextDial({ agent: {} }).effective,
    actionGrants: {},
    isCurrentOwner: true,
    taskCreateDirectChildren: [],
    taskAssignTargets: [],
    creatorUpdateTargets: [],
    mentionTargets: [],
    pluginTools: [],
  };
}

export function composedPluginToolRuntime() {
  const bearer = mintPromptCapabilityBearer(new Uint8Array(32).fill(13));
  const installation = { status: "ready", manifestIdentity: "manifest-v1" };
  const compile: RuntimeInterfaceCompileInput = {
    ...compileInput(),
    actionGrants: {},
    // This fixture isolates plugin-tool binding. The automatic owner update
    // action is covered by the runtime action tests instead.
    isCurrentOwner: false,
    pluginTools: [
      {
        installationId: "plugin-installation",
        manifestIdentity: "manifest-v1",
        name: "acme.search__lookup",
        toolName: "lookup",
        title: "Lookup",
        description: "Look up an external record",
        inputSchema: { type: "object" },
      },
    ],
  };
  const originalCall = vi.fn(async () => ({
    ok: true as const,
    content: "original worker",
  }));
  let selectedWorker = {
    status: "running" as const,
    manifestIdentity: "manifest-v1",
    call: originalCall,
  };
  let afterWorkerSelection: (() => void) | undefined;
  const getWorker = vi.fn(() => {
    const worker = selectedWorker;
    afterWorkerSelection?.();
    afterWorkerSelection = undefined;
    return worker;
  });
  const createPluginRunContext = vi.fn(
    async (input: Parameters<PromptCapabilityGatewayRepository["createPluginRunContext"]>[0]) => {
      if (installation.status !== "ready" || installation.manifestIdentity !== input.pluginManifestIdentity) {
        throw new Error("Plugin context is not bound to a ready tool");
      }
    },
  );
  const authenticated = async () => ({
    kind: "authenticated" as const,
    capability,
  });
  const repository = {
    authenticateBearerHash: authenticated,
    revalidate: authenticated,
    resolveCompileInput: vi.fn(async () => compile),
    createPluginRunContext,
  } as unknown as PromptCapabilityGatewayRepository;
  const runtimeToolGateway = createRuntimeToolGateway({
    managedTools: {} as never,
    pluginTools: createRuntimePluginToolPort({ getWorker } as never),
    callLedger: {
      claim: vi.fn(async () => ({
        state: "claimed" as const,
        id: "plugin-call-1",
      })),
      complete: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    } as never,
  });

  return {
    bearer,
    createPluginRunContext,
    gateway: createPromptCapabilityGateway({
      repository,
      executor: runtimeToolGateway,
      now: () => now,
    }),
    originalCall,
    stageChangeBeforeMint(change: "status" | "manifest identity", replacementCall: typeof originalCall) {
      afterWorkerSelection = () => {
        installation.status = change === "status" ? "disabled" : "ready";
        installation.manifestIdentity = change === "manifest identity" ? "manifest-v2" : "manifest-v1";
        selectedWorker = {
          status: "running",
          manifestIdentity: change === "manifest identity" ? "manifest-v2" : "manifest-v1",
          call: replacementCall,
        };
      };
    },
  };
}
