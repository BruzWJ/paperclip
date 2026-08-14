import type { Db } from "@paperclipai/db";
import type { SecretsRuntimeConfig } from "../secrets/types.js";
import { registerSecretProviderRoutes } from "./secret-provider-routes.js";
import { createSecretRouteContext, type SecretRouteContext } from "./secret-route-context.js";
import { registerUserSecretRoutes } from "./user-secret-routes.js";

import {
  updateSecretSchema,
  createSecretSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  rotateSecretSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, getAccessibleResource, assertCompanyAccess } from "./authz.js";

type CompanySecretRoutesContext = Pick<
  SecretRouteContext,
  "router" | "db" | "svc" | "defaultProvider" | "isCompanyScopedSecret"
>;

export function registerCompanySecretRoutes(context: CompanySecretRoutesContext): void {
  const { router, db, svc, defaultProvider, isCompanyScopedSecret } = context;

  router.post("/companies/:companyId/secrets", validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        key: req.body.key,
        provider: req.body.provider ?? defaultProvider,
        providerConfigId: req.body.providerConfigId,
        managedMode: req.body.managedMode,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
        providerMetadata: req.body.providerMetadata,
      },
      { type: "user", userId: req.actor.userId },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
  });

  router.post(
    "/companies/:companyId/secrets/remote-import/preview",
    validate(remoteSecretImportPreviewSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const preview = await svc.previewRemoteImport(companyId, {
        providerConfigId: req.body.providerConfigId,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "secret.remote_import.previewed",
        entityType: "secret_provider_config",
        entityId: preview.providerConfigId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          readyCount: preview.candidates.filter((candidate) => candidate.status === "ready").length,
          duplicateCount: preview.candidates.filter((candidate) => candidate.status === "duplicate").length,
          conflictCount: preview.candidates.filter((candidate) => candidate.status === "conflict").length,
        },
      });

      res.json(preview);
    },
  );

  router.post(
    "/companies/:companyId/secrets/remote-import",
    validate(remoteSecretImportSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await svc.importRemoteSecrets(
        companyId,
        {
          providerConfigId: req.body.providerConfigId,
          secrets: req.body.secrets,
        },
        { type: "user", userId: req.actor.userId },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "secret.remote_import.completed",
        entityType: "secret_provider_config",
        entityId: result.providerConfigId,
        details: {
          provider: result.provider,
          importedCount: result.importedCount,
          skippedCount: result.skippedCount,
          errorCount: result.errorCount,
        },
      });

      res.json(result);
    },
  );

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
        providerConfigId: req.body.providerConfigId,
      },
      { type: "user", userId: req.actor.userId },
    );

    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    res.json(rotated);
  });
}

type SecretItemRoutesContext = Pick<SecretRouteContext, "router" | "db" | "svc" | "isCompanyScopedSecret">;

export function registerSecretItemRoutes(context: SecretItemRoutesContext): void {
  const { router, db, svc, isCompanyScopedSecret } = context;

  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const updated = await svc.update(
      id,
      {
        name: req.body.name,
        key: req.body.key,
        status: req.body.status,
        providerConfigId: req.body.providerConfigId,
        description: req.body.description,
        externalRef: req.body.externalRef,
        providerMetadata: req.body.providerMetadata,
      },
      { type: "user", userId: req.actor.userId },
    );

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  router.get("/secrets/:id/usage", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    const bindings = await svc.listBindingReferences(existing.companyId, existing.id);
    res.json({ secretId: existing.id, bindings });
  });

  router.get("/secrets/:id/access-events", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    const events = await svc.listAccessEvents(existing.companyId, existing.id);
    res.json(events);
  });

  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;

    const removed = await svc.remove(id, {
      type: "user",
      userId: req.actor.userId,
    });
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });
}

export function secretRoutes(db: Db, secretsRuntime: SecretsRuntimeConfig) {
  const context = createSecretRouteContext(db, secretsRuntime);
  registerSecretProviderRoutes(context);
  registerUserSecretRoutes(context);
  registerCompanySecretRoutes(context);
  registerSecretItemRoutes(context);
  return context.router;
}
