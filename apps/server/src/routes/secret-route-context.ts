import type { Db } from "@paperclipai/db";
import { Router } from "express";
import { forbidden } from "../errors.js";
import type { SecretsRuntimeConfig } from "../secrets/types.js";
import { secretService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, assertCurrentBoardUser } from "./authz.js";

function secretDefinitionAdminUserId(req: Parameters<typeof assertBoard>[0], companyId: string) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  if (req.actor.isInstanceAdmin) return req.actor.userId;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  if (membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole))) {
    return req.actor.userId;
  }
  throw forbidden("Company admin access required");
}

function isCompanyScopedSecret(secret: { scope?: string | null }) {
  return (secret.scope ?? "company") === "company";
}

function currentUserSecretOwnerId(req: Parameters<typeof assertBoard>[0], companyId: string, userId: string) {
  assertCurrentBoardUser(req, userId);
  assertCompanyAccess(req, companyId);
  return userId;
}

export function createSecretRouteContext(db: Db, secretsRuntime: SecretsRuntimeConfig) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = secretService(db, secretsRuntime);
  const defaultProvider = secretsRuntime.defaultProvider;
  return {
    router,
    db,
    secretsRuntime,
    svc,
    defaultProvider,
    secretDefinitionAdminUserId,
    isCompanyScopedSecret,
    currentUserSecretOwnerId,
  };
}

export type SecretRouteContext = ReturnType<typeof createSecretRouteContext>;
export type SecretRouteOptions = Parameters<typeof createSecretRouteContext>[1];
