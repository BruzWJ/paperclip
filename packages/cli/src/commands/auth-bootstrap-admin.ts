import { createHash, randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { createDb, resolveDatabaseTarget, type Db } from "@paperclipai/db";
import { instanceUserRoles, invites } from "@paperclipai/db/schema";
import {
  isAllInterfacesHost,
  parseExactPublicOrigin,
  resolveRuntimeBind,
  type PaperclipConfig,
} from "@paperclipai/shared";
import { loadPaperclipEnvironmentFiles } from "../config/env.js";
import { detectTailnetBindHost } from "../config/server-bind.js";
import { readConfig, resolveConfigPath } from "../config/store.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createInviteToken() {
  return `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
}

export function resolveBootstrapAdminInviteBaseUrl(input: {
  config: PaperclipConfig;
  explicitBaseUrl?: string;
  environmentPublicUrl?: string;
}) {
  const { config } = input;
  const explicitBaseUrl = input.explicitBaseUrl?.trim() || undefined;
  const environmentPublicUrl = input.environmentPublicUrl?.trim() || undefined;
  const persistedPublicUrl = config.auth.publicBaseUrl;

  if (config.server.exposure === "public") {
    const explicit = explicitBaseUrl
      ? parseExactPublicOrigin(explicitBaseUrl)
      : undefined;
    const fromEnv = environmentPublicUrl
      ? parseExactPublicOrigin(environmentPublicUrl)
      : undefined;
    const persisted = persistedPublicUrl
      ? parseExactPublicOrigin(persistedPublicUrl)
      : undefined;
    const configuredOrigins = [explicit, fromEnv, persisted].filter(
      (value): value is string => Boolean(value),
    );
    if (new Set(configuredOrigins).size > 1) {
      throw new Error(
        "The bootstrap base URL must match the canonical public URL for public exposure",
      );
    }
    const canonicalPublicUrl = configuredOrigins[0];
    if (!canonicalPublicUrl) {
      throw new Error(
        "Public exposure requires PAPERCLIP_PUBLIC_URL or persisted auth.publicBaseUrl",
      );
    }
    return canonicalPublicUrl;
  }

  if (explicitBaseUrl || environmentPublicUrl || persistedPublicUrl) {
    throw new Error(
      "Private exposure derives its auth origin from requests; remove the public URL",
    );
  }
  const resolvedBind = resolveRuntimeBind({
    exposure: config.server.exposure,
    bind: config.server.bind,
    customBindHost: config.server.customBindHost,
    tailnetBindHost:
      config.server.bind === "tailnet" ? detectTailnetBindHost() : undefined,
  });
  const port = config.server.port ?? 3100;
  const publicHost = isAllInterfacesHost(resolvedBind.host)
    ? "localhost"
    : resolvedBind.host;
  return `http://${publicHost}:${port}`;
}

export type BootstrapAdminCapabilityResult =
  { status: "created"; expiresAt: Date } | { status: "closed" };

export async function createBootstrapAdminCapability(
  db: Db,
  input: {
    tokenHash: string;
    now: Date;
    expiresAt: Date;
  },
): Promise<BootstrapAdminCapabilityResult> {
  return db.transaction(async (tx) => {
    // This lock matches first-admin redemption's lock order. It makes the
    // eligibility check atomic with capability replacement and prevents a
    // concurrent claim from racing creation.
    await tx.execute(
      sql`lock table ${instanceUserRoles} in share row exclusive mode`,
    );
    await tx.execute(sql`lock table ${invites} in share row exclusive mode`);

    const existingAdmin = await tx
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"))
      .then((rows) => rows[0] ?? null);

    if (existingAdmin) {
      return { status: "closed" as const };
    }

    await tx
      .update(invites)
      .set({ revokedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(invites.inviteType, "bootstrap_admin"),
          isNull(invites.revokedAt),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, input.now),
        ),
      );

    const created = await tx
      .insert(invites)
      .values({
        inviteType: "bootstrap_admin",
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        source: "bootstrap_admin_cli",
        invitedByUserId: null,
      })
      .returning({ expiresAt: invites.expiresAt })
      .then((rows) => rows[0]);

    if (!created) {
      throw new Error("Bootstrap capability insert returned no row");
    }

    return { status: "created" as const, expiresAt: created.expiresAt };
  });
}

export async function bootstrapAdminInvite(opts: {
  config?: string;
  expiresHours?: number;
  baseUrl?: string;
}) {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvironmentFiles(configPath);
  const config = readConfig(configPath);
  if (!config) {
    p.log.error(
      `No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`,
    );
    return;
  }

  let closableDb:
    | (Db & {
        $client?: {
          end?: (options?: { timeout?: number }) => Promise<void>;
        };
      })
    | undefined;
  try {
    // Resolve every origin input before opening the database or its creation
    // transaction. A bad public URL must never revoke or create a capability.
    const baseUrl = resolveBootstrapAdminInviteBaseUrl({
      config,
      explicitBaseUrl: opts.baseUrl,
      environmentPublicUrl: process.env.PAPERCLIP_PUBLIC_URL,
    });

    const requestedExpiresHours = opts.expiresHours ?? 72;
    if (!Number.isFinite(requestedExpiresHours)) {
      throw new Error(
        "Bootstrap capability expiration must be a finite number of hours",
      );
    }
    const expiresHours = Math.max(1, Math.min(24 * 30, requestedExpiresHours));

    const dbUrl = resolveDatabaseTarget({ configPath }).connectionString;
    const db = createDb(dbUrl);
    closableDb = db;

    const now = new Date();
    const token = createInviteToken();
    const capability = await createBootstrapAdminCapability(db, {
      tokenHash: hashToken(token),
      now,
      expiresAt: new Date(now.getTime() + expiresHours * 60 * 60 * 1000),
    });

    if (capability.status === "closed") {
      p.log.info(
        "Instance already has an admin user. Bootstrap capability creation is closed.",
      );
      return;
    }

    const inviteUrl = `${baseUrl}/invite/${token}`;
    p.log.success("Created bootstrap admin invite.");
    p.log.message(`Invite URL: ${pc.cyan(inviteUrl)}`);
    p.log.message(`Expires: ${pc.dim(capability.expiresAt.toISOString())}`);
  } catch (err) {
    throw new Error(
      `Could not create bootstrap invite: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await closableDb?.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}
