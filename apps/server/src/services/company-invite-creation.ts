import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { invites } from "@paperclipai/db";
import {
  HUMAN_COMPANY_MEMBERSHIP_ROLES,
  grantsForHumanRole,
  type HumanCompanyMembershipRole,
  type InviteJoinType,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";

const INVITE_TOKEN_PREFIX = "pcp_invite_";
const INVITE_TOKEN_ENTROPY_BYTES = 32;
const INVITE_TOKEN_MAX_RETRIES = 5;
const COMPANY_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export type CompanyInviteProvenance =
  | { source: "board_api"; invitedByUserId: string }
  | { source: "plugin_host" };

export interface CreateCompanyInviteInput {
  companyId: string;
  provenance: CompanyInviteProvenance;
  allowedJoinTypes?: InviteJoinType;
  humanRole?: HumanCompanyMembershipRole | string | null;
  defaultsPayload?: Record<string, unknown> | null;
  agentMessage?: string | null;
}

export function createInviteToken(): string {
  const suffix = randomBytes(INVITE_TOKEN_ENTROPY_BYTES).toString("base64url");
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function companyInviteExpiresAt(nowMs: number = Date.now()): Date {
  return new Date(nowMs + COMPANY_INVITE_TTL_MS);
}

function requireHumanRole(
  value: HumanCompanyMembershipRole | string | null | undefined,
): HumanCompanyMembershipRole {
  const role = value ?? "operator";
  if (!HUMAN_COMPANY_MEMBERSHIP_ROLES.some((candidate) => candidate === role)) {
    throw new Error(`Invalid human invite role: ${role}`);
  }
  return role as HumanCompanyMembershipRole;
}

function mergeCompanyInviteDefaults(input: {
  defaultsPayload: Record<string, unknown> | null | undefined;
  agentMessage: string | null;
  humanRole: HumanCompanyMembershipRole | null;
}): Record<string, unknown> | null {
  const merged = { ...(input.defaultsPayload ?? {}) };
  if (input.humanRole) {
    const existingHuman =
      typeof merged.human === "object"
      && merged.human !== null
      && !Array.isArray(merged.human)
        ? { ...merged.human as Record<string, unknown> }
        : {};
    merged.human = {
      ...existingHuman,
      role: input.humanRole,
      grants: grantsForHumanRole(input.humanRole),
    };
  }
  if (input.agentMessage) merged.agentMessage = input.agentMessage;
  return Object.keys(merged).length > 0 ? merged : null;
}

function isInviteTokenHashCollision(error: unknown): boolean {
  const candidates = [
    error,
    (error as { cause?: unknown } | null)?.cause ?? null,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const code =
      "code" in candidate && typeof candidate.code === "string"
        ? candidate.code
        : null;
    if (code !== "23505") continue;
    const constraint =
      "constraint" in candidate && typeof candidate.constraint === "string"
        ? candidate.constraint
        : null;
    const message =
      "message" in candidate && typeof candidate.message === "string"
        ? candidate.message
        : "";
    if (
      constraint === "invites_token_hash_unique_idx"
      || message.includes("invites_token_hash_unique_idx")
    ) {
      return true;
    }
  }
  return false;
}

export async function createCompanyInvite(
  db: Db,
  input: CreateCompanyInviteInput,
): Promise<{
  token: string;
  invite: typeof invites.$inferSelect;
  normalizedAgentMessage: string | null;
}> {
  const allowedJoinTypes = input.allowedJoinTypes ?? "both";
  const humanRole = allowedJoinTypes === "agent"
    ? null
    : requireHumanRole(input.humanRole);
  const normalizedAgentMessage = typeof input.agentMessage === "string"
    ? input.agentMessage.trim() || null
    : null;
  const invitedByUserId = input.provenance.source === "board_api"
    ? input.provenance.invitedByUserId
    : null;
  const insertValues = {
    companyId: input.companyId,
    inviteType: "company_join" as const,
    allowedJoinTypes,
    defaultsPayload: mergeCompanyInviteDefaults({
      defaultsPayload: input.defaultsPayload,
      agentMessage: normalizedAgentMessage,
      humanRole,
    }),
    expiresAt: companyInviteExpiresAt(),
    source: input.provenance.source,
    invitedByUserId,
  };

  for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
    const token = createInviteToken();
    try {
      const invite = await db
        .insert(invites)
        .values({ ...insertValues, tokenHash: hashInviteToken(token) })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!invite) throw new Error("Company invite insert returned no row");
      return { token, invite, normalizedAgentMessage };
    } catch (error) {
      if (!isInviteTokenHashCollision(error)) throw error;
    }
  }

  throw conflict("Failed to generate a unique invite token. Please retry.");
}
