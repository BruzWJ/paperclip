import type {
  McpServer,
  StopReason,
  SessionConfigValueId,
} from "@agentclientprotocol/sdk";
import type { ApprovedAcpLaunch } from "./agent-registry.js";

export const ACP_SUBPROCESS_CONTRACT_VERSION = "acp-subprocess/v1" as const;
export const ACP_STABLE_WIRE_VERSION = 1 as const;

export type AcpSessionConfigValue = boolean | SessionConfigValueId;

export interface AcpSessionConfigSelection {
  readonly configId: string;
  readonly value: AcpSessionConfigValue;
}

export interface AcpSubprocessLaunch {
  readonly version: typeof ACP_SUBPROCESS_CONTRACT_VERSION;
  readonly launch: ApprovedAcpLaunch;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly mcpServers: readonly McpServer[];
  readonly configOptions: readonly AcpSessionConfigSelection[];
}

export type AcpSessionStart =
  | { readonly kind: "new" }
  | { readonly kind: "resume"; readonly sessionId: string };

export interface AcpPromptRequest {
  readonly start: AcpSessionStart;
  readonly message: string;
}

export interface AcpTerminalOccupancy {
  readonly used: number;
  readonly size: number;
  readonly cost:
    | { readonly amount: number; readonly currency: string }
    | null;
}

export interface AcpPromptSettlement {
  readonly kind: "protocol_settled";
  readonly stopReason: StopReason;
  readonly occupancy: AcpTerminalOccupancy;
}

export type AcpSessionSetupFailureKind = "target_not_found" | "error";
