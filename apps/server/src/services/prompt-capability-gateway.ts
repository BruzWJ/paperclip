import { createHash, randomBytes } from "node:crypto";
import type { IssueExecutionRefMode } from "@paperclipai/shared";
import {
  compileRuntimeInterface,
  type CompiledRunToolDescriptor,
  type RuntimeInterfaceCompileInput,
  type RuntimeToolSource,
} from "./runtime-interface-compiler.js";
import { RuntimeToolUnavailable } from "./runtime-tool-errors.js";

const PROMPT_CAPABILITY_BEARER_PREFIX = "pc_run_v1_";
const PLUGIN_RUN_CONTEXT_HANDLE_PREFIX = "pc_plugin_ctx_v1_";
const OPAQUE_CREDENTIAL_ENTROPY_PATTERN = "[A-Za-z0-9_-]{43}";
const PROMPT_CAPABILITY_BEARER_PATTERN = new RegExp(
  `^${PROMPT_CAPABILITY_BEARER_PREFIX}${OPAQUE_CREDENTIAL_ENTROPY_PATTERN}$`,
);
const PLUGIN_RUN_CONTEXT_HANDLE_PATTERN = new RegExp(
  `^${PLUGIN_RUN_CONTEXT_HANDLE_PREFIX}${OPAQUE_CREDENTIAL_ENTROPY_PATTERN}$`,
);

/**
 * The authenticated in-memory projection of one exact active prompt
 * capability generation. It is rebuilt from canonical rows for every
 * operation; it is not a second session, token, or identity owner.
 */
export interface PromptCapabilityCompileScope {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly executionMode: IssueExecutionRefMode;
  readonly issueExecutionAuthorityId: string | null;
  readonly consultExecutionId: string | null;
  /**
   * Exact prompt identity used only to derive recovery availability. Generic
   * compilation callers omit it; it is never persisted as a separate mode.
   */
  readonly sessionId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly refId?: string;
  readonly refOrdinal?: number;
  readonly segmentOrdinal?: number;
}

export interface PromptCapabilityBinding
  extends PromptCapabilityCompileScope {
  readonly capabilityConnectionId: string;
  readonly capabilityGeneration: number;
  readonly runId: string;
  readonly runBatchDigest: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly workerProcessIdentity: string;
  readonly sessionId: string;
  readonly laneKind: IssueExecutionRefMode;
  readonly adapterConfigIdentity: string;
  readonly workspaceIdentity: string;
  readonly targetSessionCorrelationId: string;
  readonly effectiveContextExposureDigest: string;
  readonly effectiveToolsDigest: string;
  /**
   * Derived from the exact source prompt while this binding is authenticated.
   * It is deliberately not a persisted capability property or identity fact.
   */
  readonly bootstrapToolGate: boolean;
  readonly expiresAt: Date;
  readonly activatedAt: Date;
  readonly createdAt: Date;
}

/**
 * Minimal authenticated bearer projection used only to ledger and reject an
 * ingress operation before prompt setup has activated the executable binding.
 */
export interface PromptCapabilityIngressBinding {
  readonly companyId: string;
  readonly capabilityConnectionId: string;
  readonly capabilityGeneration: number;
  readonly runId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
  readonly issueId: string;
  readonly targetAgentId: string;
}

/** Stable, non-secret identity of one canonical capability generation. */
export function promptCapabilityGenerationIdentity(
  capability: Pick<
    PromptCapabilityBinding,
    "capabilityConnectionId" | "capabilityGeneration"
  >,
): string {
  return `${capability.capabilityConnectionId}:${capability.capabilityGeneration}`;
}

export type PromptCapabilityCallIdentity =
  | { readonly source: "provider"; readonly id: string }
  | { readonly source: "jsonrpc"; readonly id: string | number };

export interface PromptCapabilityPluginContext {
  readonly capability: PromptCapabilityBinding;
  readonly runInterfaceToolCallId: string;
  readonly pluginInstallationId: string;
}

export type PromptCapabilityAuthenticationResult =
  | { readonly kind: "authenticated"; readonly capability: PromptCapabilityBinding }
  | { readonly kind: "inactive" }
  | { readonly kind: "authority_invalid"; readonly reason: string };

export type PromptCapabilityIngressAuthenticationResult =
  | {
      readonly kind: "authenticated";
      readonly capability: PromptCapabilityIngressBinding;
    }
  | { readonly kind: "inactive" }
  | { readonly kind: "authority_invalid"; readonly reason: string };

export interface PromptCapabilityGatewayRepository {
  authenticateIngressBearerHash(
    bearerHash: string,
    at: Date,
  ): Promise<PromptCapabilityIngressAuthenticationResult>;
  authenticateBearerHash(
    bearerHash: string,
    at: Date,
  ): Promise<PromptCapabilityAuthenticationResult>;
  revalidate(
    capability: PromptCapabilityBinding,
    at: Date,
  ): Promise<PromptCapabilityAuthenticationResult>;
  resolveCompileInput(
    capability: PromptCapabilityBinding,
  ): Promise<RuntimeInterfaceCompileInput>;
  createPluginRunContext(input: {
    capability: PromptCapabilityBinding;
    runInterfaceToolCallId: string;
    pluginInstallationId: string;
    pluginManifestIdentity: string;
    handleHash: string;
    createdAt: Date;
  }): Promise<void>;
  resolvePluginRunContextHash(
    handleHash: string,
    at: Date,
  ): Promise<PromptCapabilityPluginContext | null>;
}

export interface PromptCapabilityToolExecutor {
  registerTerminalInvalid(input: {
    capability: PromptCapabilityIngressBinding;
    descriptor: Pick<
      CompiledRunToolDescriptor,
      | "name"
      | "pluginInstallationId"
    >;
    arguments: unknown;
    callIdentity: PromptCapabilityCallIdentity | null;
    ingressOrdinal: number;
    error: unknown;
  }): Promise<void>;
  execute(input: {
    capability: PromptCapabilityBinding;
    descriptor: CompiledRunToolDescriptor;
    arguments: unknown;
    callIdentity: PromptCapabilityCallIdentity;
    ingressOrdinal: number;
    mintPluginRunContext(input: {
      runInterfaceToolCallId: string;
      pluginInstallationId: string;
      pluginManifestIdentity: string;
    }): Promise<string>;
  }): Promise<PromptCapabilityToolExecutionResult>;
}

/**
 * Closed result boundary between the authoritative runtime dispatcher and its
 * MCP transport. The source discriminator is compiler-owned, so plugin SDK
 * results never have to be guessed from an arbitrary JSON value.
 */
export interface PromptCapabilityToolExecutionResult {
  readonly source: RuntimeToolSource;
  readonly value: unknown;
}

export class PromptCapabilityAuthenticationError extends Error {
  readonly code = "prompt_capability_authentication_failed";

  constructor(message = "Invalid or expired prompt-capability bearer") {
    super(message);
    this.name = "PromptCapabilityAuthenticationError";
  }
}

export class PromptCapabilityAuthorityError extends Error {
  readonly code = "prompt_capability_authority_invalid";

  constructor(readonly reason: string) {
    super(`Prompt capability is no longer authoritative: ${reason}`);
    this.name = "PromptCapabilityAuthorityError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomPluginRunContextHandle(): string {
  return `${PLUGIN_RUN_CONTEXT_HANDLE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Sole raw bearer constructor shared with the ACP prompt-cycle mint owner.
 * Persistence still stores only SHA-256; this helper owns only the credential
 * class and entropy so mint and authentication cannot drift.
 */
export function mintPromptCapabilityBearer(
  entropy: Uint8Array = randomBytes(32),
): string {
  if (entropy.byteLength !== 32) {
    throw new Error("Prompt-capability bearer entropy must be exactly 32 bytes");
  }
  return `${PROMPT_CAPABILITY_BEARER_PREFIX}${Buffer.from(entropy).toString("base64url")}`;
}

export function assertRunBearerRejectedByGenericApi(
  credential: string,
): void {
  if (credential.startsWith(PROMPT_CAPABILITY_BEARER_PREFIX)) {
    throw new PromptCapabilityAuthenticationError(
      "Prompt-capability bearers are not valid generic API credentials",
    );
  }
}

export function assertPromptCapabilityCredential(
  credential: string,
): void {
  if (!PROMPT_CAPABILITY_BEARER_PATTERN.test(credential)) {
    throw new PromptCapabilityAuthenticationError(
      "Only paperclip.run-tools/v1 prompt-capability bearers authenticate this interface",
    );
  }
}

function assertPluginRunContextHandle(handle: string): void {
  if (!PLUGIN_RUN_CONTEXT_HANDLE_PATTERN.test(handle)) {
    throw new PromptCapabilityAuthenticationError(
      "Invalid plugin run-context handle",
    );
  }
}

function authenticated(
  result: PromptCapabilityAuthenticationResult,
): PromptCapabilityBinding {
  if (result.kind === "authenticated") return result.capability;
  if (result.kind === "authority_invalid") {
    throw new PromptCapabilityAuthorityError(result.reason);
  }
  throw new PromptCapabilityAuthenticationError();
}

function assertIngressOrdinal(ingressOrdinal: number): void {
  if (!Number.isSafeInteger(ingressOrdinal) || ingressOrdinal < 0) {
    throw new PromptCapabilityAuthenticationError(
      "Invalid private run-tools ingress ordinal",
    );
  }
}

export function createPromptCapabilityGateway(options: {
  readonly repository: PromptCapabilityGatewayRepository;
  readonly executor: PromptCapabilityToolExecutor;
  readonly now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  async function authenticate(
    bearer: string,
  ): Promise<PromptCapabilityBinding> {
    assertPromptCapabilityCredential(bearer);
    const result = await options.repository.authenticateBearerHash(
      sha256(bearer),
      now(),
    );
    return authenticated(result);
  }

  async function authenticateIngress(
    bearer: string,
  ): Promise<PromptCapabilityIngressBinding> {
    assertPromptCapabilityCredential(bearer);
    const result = await options.repository.authenticateIngressBearerHash(
      sha256(bearer),
      now(),
    );
    if (result.kind === "authenticated") return result.capability;
    if (result.kind === "authority_invalid") {
      throw new PromptCapabilityAuthorityError(result.reason);
    }
    throw new PromptCapabilityAuthenticationError();
  }

  async function requireStillAuthoritative(
    capability: PromptCapabilityBinding,
  ): Promise<PromptCapabilityBinding> {
    return authenticated(await options.repository.revalidate(capability, now()));
  }

  async function mintPluginRunContext(input: {
    capability: PromptCapabilityBinding;
    runInterfaceToolCallId: string;
    pluginInstallationId: string;
    pluginManifestIdentity: string;
  }): Promise<string> {
    const current = await requireStillAuthoritative(input.capability);
    const handle = randomPluginRunContextHandle();
    await options.repository.createPluginRunContext({
      capability: current,
      runInterfaceToolCallId: input.runInterfaceToolCallId,
      pluginInstallationId: input.pluginInstallationId,
      pluginManifestIdentity: input.pluginManifestIdentity,
      handleHash: sha256(handle),
      createdAt: now(),
    });
    return handle;
  }

  return {
    async listTools(
      bearer: string,
    ): Promise<readonly CompiledRunToolDescriptor[]> {
      const capability = await authenticate(bearer);
      const compileInput =
        await options.repository.resolveCompileInput(capability);
      const compiled = compileRuntimeInterface(compileInput);
      await requireStillAuthoritative(capability);
      return compiled.descriptors;
    },

    async callTool(input: {
      bearer: string;
      toolName: string;
      arguments: unknown;
      callIdentity: PromptCapabilityCallIdentity;
      ingressOrdinal: number;
    }): Promise<PromptCapabilityToolExecutionResult> {
      assertIngressOrdinal(input.ingressOrdinal);
      const capability = await authenticate(input.bearer);
      const compileInput =
        await options.repository.resolveCompileInput(capability);
      const compiled = compileRuntimeInterface(compileInput);
      const descriptor = compiled.byName.get(input.toolName);
      if (!descriptor) {
        const current = await requireStillAuthoritative(capability);
        const unavailable = new RuntimeToolUnavailable(input.toolName);
        await options.executor.registerTerminalInvalid({
          capability: current,
          descriptor: { name: input.toolName },
          arguments: input.arguments,
          callIdentity: input.callIdentity,
          ingressOrdinal: input.ingressOrdinal,
          error: unavailable,
        });
        throw unavailable;
      }
      const current = await requireStillAuthoritative(capability);
      if (
        descriptor.name === "restore_session" &&
        !current.bootstrapToolGate
      ) {
        const unavailable = new RuntimeToolUnavailable(
          input.toolName,
          `Tool is unavailable outside recovery bootstrap: ${input.toolName}`,
        );
        await options.executor.registerTerminalInvalid({
          capability: current,
          descriptor,
          arguments: input.arguments,
          callIdentity: input.callIdentity,
          ingressOrdinal: input.ingressOrdinal,
          error: unavailable,
        });
        throw unavailable;
      }
      if (current.bootstrapToolGate && descriptor.bootstrapEnabled !== true) {
        const unavailable = new RuntimeToolUnavailable(
          input.toolName,
          `Tool is unavailable during instruction bootstrap: ${input.toolName}`,
        );
        await options.executor.registerTerminalInvalid({
          capability: current,
          descriptor,
          arguments: input.arguments,
          callIdentity: input.callIdentity,
          ingressOrdinal: input.ingressOrdinal,
          error: unavailable,
        });
        throw unavailable;
      }
      const result = await options.executor.execute({
        capability: current,
        descriptor,
        arguments: input.arguments,
        callIdentity: input.callIdentity,
        ingressOrdinal: input.ingressOrdinal,
        mintPluginRunContext: (pluginInput) =>
          mintPluginRunContext({ capability: current, ...pluginInput }),
      });
      return result;
    },

    async registerTerminalInvalidToolCall(input: {
      bearer: string;
      toolName: string | null;
      arguments: unknown;
      callIdentity: PromptCapabilityCallIdentity | null;
      ingressOrdinal: number;
      error: unknown;
    }): Promise<void> {
      assertIngressOrdinal(input.ingressOrdinal);
      const capability = await authenticateIngress(input.bearer);
      await options.executor.registerTerminalInvalid({
        capability,
        descriptor: {
          name: input.toolName ?? "<invalid-tools-call>",
        },
        arguments: input.arguments,
        callIdentity: input.callIdentity,
        ingressOrdinal: input.ingressOrdinal,
        error: input.error,
      });
    },

    async resolvePluginRunContext(
      handle: string,
      expectedPluginInstallationId: string,
    ): Promise<PromptCapabilityPluginContext> {
      assertPluginRunContextHandle(handle);
      const resolved = await options.repository.resolvePluginRunContextHash(
        sha256(handle),
        now(),
      );
      if (
        !resolved ||
        resolved.pluginInstallationId !== expectedPluginInstallationId
      ) {
        throw new PromptCapabilityAuthenticationError(
          "Invalid plugin run-context handle",
        );
      }
      const current = await requireStillAuthoritative(resolved.capability);
      return { ...resolved, capability: current };
    },
  };
}

export type PromptCapabilityGateway = ReturnType<
  typeof createPromptCapabilityGateway
>;
