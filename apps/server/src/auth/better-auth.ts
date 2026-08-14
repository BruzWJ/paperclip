import type { Request, RequestHandler } from "express";
import { betterAuth, type Auth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import { type Db, authAccounts, authSessions, authUsers, authVerifications } from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import {
  canonicalNodeRequestHeaders,
  canonicalRequestHeaders,
  requireRequestAuthority,
} from "../http/request-authority.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthGetSessionApi = {
  getSession: (input: { headers: Headers }) => Promise<unknown>;
};

type BetterAuthHandlerTarget = Extract<Parameters<typeof toNodeHandler>[0], { handler: Auth["handler"] }>;

type BetterAuthSessionResolver = {
  api: BetterAuthGetSessionApi;
};

type BetterAuthInstance = BetterAuthHandlerTarget & BetterAuthSessionResolver;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  return `paperclip-${resolvePaperclipInstanceId(instanceId)}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    trustedProxyHeaders: false,
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldEnableAuthRateLimit(input: {
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}): boolean {
  const override = input.override?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;

  return true;
}

export function buildBetterAuthRateLimitOptions(input: {
  deploymentExposure?: Config["deploymentExposure"];
  override?: string | undefined;
}) {
  return {
    enabled: shouldEnableAuthRateLimit(input),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentExposure?: Config["deploymentExposure"];
}): boolean {
  return input.deploymentExposure !== "public";
}

function headersFromExpressRequest(req: Request): Headers {
  return canonicalRequestHeaders(req.headers, requireRequestAuthority(req));
}

export function createBetterAuthInstance(db: Db, config: Config): BetterAuthInstance {
  const baseUrl = config.deploymentExposure === "public" ? config.authPublicBaseUrl : undefined;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret?.trim()) {
    throw new Error("BETTER_AUTH_SECRET must be set before server startup.");
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentExposure: config.deploymentExposure,
  });

  const authConfig = {
    baseURL: baseUrl,
    secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    rateLimit: buildBetterAuthRateLimitOptions({
      deploymentExposure: config.deploymentExposure,
      override: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    }),
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthHandlerTarget): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    const originalHeaders = req.headers;
    req.headers = canonicalNodeRequestHeaders(originalHeaders, requireRequestAuthority(req));
    void Promise.resolve(handler(req, res))
      .catch(next)
      .finally(() => {
        req.headers = originalHeaders;
      });
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthSessionResolver,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const sessionValue = await auth.api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session =
    value.session?.id && value.session.userId ? { id: value.session.id, userId: value.session.userId } : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthSessionResolver,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
