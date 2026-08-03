export interface SessionCompactionSettings {
  /**
   * A sparse document of company overrides. Omission deliberately preserves the
   * Paperclip's derived behavior; it is not a request to store a materialized
   * default.
   */
  auto?: boolean;
  prune?: boolean;
  reserved?: number;
  tail_turns?: number;
  preserve_recent_tokens?: number;
  modelRef?: string;
}

export type SessionCompactionHistoryScopeKind =
  | "execution-lineage"
  | "turns-composition"
  | "comments-composition";

export type SessionCompactionAudience =
  | "execution"
  | "turns"
  | "comments";

export interface SessionCompactionScope {
  kind: SessionCompactionHistoryScopeKind;
  id: string;
  audience: SessionCompactionAudience;
  sourceHighWaterSeq: number;
}
