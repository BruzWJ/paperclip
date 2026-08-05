import { createHash, randomBytes } from "node:crypto";
import type { IssueExecutionRefMode } from "@paperclipai/shared";
import { contextDialDigest } from "./context-dial-resolver.js";
import {
  compileRuntimeInterface,
  RuntimeToolUnavailable,
  type CompiledRunToolDescriptor,
  type RuntimeInterfaceCompileInput,
} from "./runtime-interface-compiler.js";
import type {
  IssueSessionDbTransaction,
} from "./issue-session/event-store.js";

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

export interface PromptCapabilityAudit {
  readonly capability: PromptCapabilityIngressBinding | null;
  readonly event: "list" | "call" | "reject" | "plugin_context";
  readonly outcome: "allowed" | "denied";
  readonly toolName?: string;
  readonly reason?: string;
  readonly dialDigest?: string;
  readonly grantSnapshot?: Readonly<Record<string, boolean>>;
  readonly occurredAt: Date;
}

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
    handleHash: string;
    createdAt: Date;
  }): Promise<void>;
  resolvePluginRunContextHash(
    handleHash: string,
    at: Date,
  ): Promise<PromptCapabilityPluginContext | null>;
  writeAudit(
    event: PromptCapabilityAudit,
    transaction?: IssueSessionDbTransaction,
  ): Promise<void>;
}

export interface PromptCapabilityToolExecutor {
  registerTerminalInvalid(input: {
    capability: PromptCapabilityIngressBinding;
    descriptor: Pick<
      CompiledRunToolDescriptor,
      | "name"
      | "selectedCompanyToolSelectionId"
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
    }): Promise<string>;
    commitTerminalAudit?(
      transaction: IssueSessionDbTransaction,
    ): Promise<void>;
  }): Promise<unknown>;
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

function grantSnapshot(
  input: RuntimeInterfaceCompileInput,
): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    Object.entries(input.actionGrants).map(([key, value]) => [
      key,
      value === true,
    ]),
  );
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

export function assertRunBearerRejectedByNamedGateway(
  credential: string,
): void {
  if (credential.startsWith(PROMPT_CAPABILITY_BEARER_PREFIX)) {
    throw new PromptCapabilityAuthenticationError(
      "Prompt-capability bearers are not valid named-gateway credentials",
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

  async function audit(
    capability: PromptCapabilityIngressBinding | null,
    event: Omit<PromptCapabilityAudit, "capability" | "occurredAt">,
  ): Promise<void> {
    await options.repository.writeAudit({
      capability,
      occurredAt: now(),
      ...event,
    });
  }

  async function authenticate(
    bearer: string,
  ): Promise<PromptCapabilityBinding> {
    try {
      assertPromptCapabilityCredential(bearer);
    } catch (error) {
      await audit(null, {
        event: "reject",
        outcome: "denied",
        reason: "wrong_credential_class",
      });
      throw error;
    }
    const result = await options.repository.authenticateBearerHash(
      sha256(bearer),
      now(),
    );
    try {
      return authenticated(result);
    } catch (error) {
      await audit(null, {
        event: "reject",
        outcome: "denied",
        reason:
          result.kind === "authority_invalid"
            ? result.reason
            : "inactive_or_expired",
      });
      throw error;
    }
  }

  async function authenticateIngress(
    bearer: string,
  ): Promise<PromptCapabilityIngressBinding> {
    try {
      assertPromptCapabilityCredential(bearer);
    } catch (error) {
      await audit(null, {
        event: "reject",
        outcome: "denied",
        reason: "wrong_credential_class",
      });
      throw error;
    }
    const result = await options.repository.authenticateIngressBearerHash(
      sha256(bearer),
      now(),
    );
    if (result.kind === "authenticated") return result.capability;
    await audit(null, {
      event: "reject",
      outcome: "denied",
      reason:
        result.kind === "authority_invalid"
          ? result.reason
          : "inactive_or_expired",
    });
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
  }): Promise<string> {
    const current = await requireStillAuthoritative(input.capability);
    const handle = randomPluginRunContextHandle();
    await options.repository.createPluginRunContext({
      capability: current,
      runInterfaceToolCallId: input.runInterfaceToolCallId,
      pluginInstallationId: input.pluginInstallationId,
      handleHash: sha256(handle),
      createdAt: now(),
    });
    await audit(current, {
      event: "plugin_context",
      outcome: "allowed",
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
      await audit(capability, {
        event: "list",
        outcome: "allowed",
        dialDigest: contextDialDigest(compileInput.contextDial),
        grantSnapshot: grantSnapshot(compileInput),
      });
      return compiled.descriptors;
    },

    async callTool(input: {
      bearer: string;
      toolName: string;
      arguments: unknown;
      callIdentity: PromptCapabilityCallIdentity;
      ingressOrdinal: number;
    }): Promise<unknown> {
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
        await audit(capability, {
          event: "call",
          outcome: "denied",
          toolName: input.toolName,
          reason: "tool_not_in_current_interface",
          dialDigest: contextDialDigest(compileInput.contextDial),
          grantSnapshot: grantSnapshot(compileInput),
        });
        throw unavailable;
      }
      const current = await requireStillAuthoritative(capability);
      const terminalMention =
        input.toolName === "mention_agent" ||
        input.toolName === "mention_board";
      const callAudit: PromptCapabilityAudit = {
        capability: current,
        occurredAt: now(),
        event: "call",
        outcome: "allowed",
        toolName: input.toolName,
        dialDigest: contextDialDigest(compileInput.contextDial),
        grantSnapshot: grantSnapshot(compileInput),
      };
      const result = await options.executor.execute({
        capability: current,
        descriptor,
        arguments: input.arguments,
        callIdentity: input.callIdentity,
        ingressOrdinal: input.ingressOrdinal,
        mintPluginRunContext: (pluginInput) =>
          mintPluginRunContext({ capability: current, ...pluginInput }),
        ...(terminalMention
          ? {
              commitTerminalAudit: (transaction: IssueSessionDbTransaction) =>
                options.repository.writeAudit(callAudit, transaction),
            }
          : {}),
      });
      if (!terminalMention) await options.repository.writeAudit(callAudit);
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
      await audit(capability, {
        event: "call",
        outcome: "denied",
        ...(input.toolName === null
          ? {}
          : { toolName: input.toolName }),
        reason: "terminal_invalid_tools_call",
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
