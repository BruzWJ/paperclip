export type AcpSessionConfigValue = boolean | string;

export interface AcpSessionConfigSelection {
  readonly configId: string;
  readonly value: AcpSessionConfigValue;
}

export type AcpSessionStart =
  | { readonly kind: "new" }
  | { readonly kind: "resume"; readonly sessionId: string };

export interface AcpTerminalOccupancy {
  readonly used: number;
  readonly size: number;
  readonly cost:
    | { readonly amount: number; readonly currency: string }
    | null;
}

export interface AcpPromptSettlement {
  readonly kind: "protocol_settled";
  readonly stopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled";
  readonly occupancy: AcpTerminalOccupancy;
}
