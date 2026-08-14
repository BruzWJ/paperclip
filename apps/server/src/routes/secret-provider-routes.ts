import {
  createSecretProviderConfigSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateSecretProviderConfigSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import type { SecretRouteContext } from "./secret-route-context.js";

type SecretProviderRoutesContext = Pick<SecretRouteContext, "router" | "db" | "svc">;

export function registerSecretProviderRoutes(context: SecretProviderRoutesContext): void {
  const { router, db, svc } = context;

  router.get("/companies/:companyId/secret-providers", (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(svc.listProviders());
  });

  router.get("/companies/:companyId/secret-providers/health", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const checks = await svc.checkProviders();
    res.json({ providers: checks });
  });

  router.get("/companies/:companyId/secret-provider-configs", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listProviderConfigs(companyId));
  });

  router.post(
    "/companies/:companyId/secret-provider-configs/discovery/preview",
    validate(secretProviderConfigDiscoveryPreviewSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const preview = await svc.previewProviderConfigDiscovery(companyId, {
        provider: req.body.provider,
        config: req.body.config,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "secret_provider_config.discovery_previewed",
        entityType: "secret_provider_config_discovery",
        entityId: companyId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          sampledSecretCount: preview.sampledSecretCount,
          warningCount: preview.warnings.length,
        },
      });

      res.json(preview);
    },
  );

  router.post(
    "/companies/:companyId/secret-provider-configs",
    validate(createSecretProviderConfigSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const created = await svc.createProviderConfig(
        companyId,
        {
          provider: req.body.provider,
          displayName: req.body.displayName,
          status: req.body.status,
          isDefault: req.body.isDefault,
          config: req.body.config,
        },
        { type: "user", userId: req.actor.userId },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "secret_provider_config.created",
        entityType: "secret_provider_config",
        entityId: created.id,
        details: {
          provider: created.provider,
          displayName: created.displayName,
          status: created.status,
          isDefault: created.isDefault,
        },
      });

      res.status(201).json(created);
    },
  );

  router.get("/secret-provider-configs/:id", async (req, res) => {
    assertBoard(req);
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getProviderConfigById(req.params.id as string),
      "Provider vault not found",
    );
    if (!existing) return;
    res.json(existing);
  });

  router.patch(
    "/secret-provider-configs/:id",
    validate(updateSecretProviderConfigSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await getAccessibleResource(
        req,
        res,
        svc.getProviderConfigById(id),
        "Provider vault not found",
      );
      if (!existing) return;

      const updated = await svc.updateProviderConfig(
        id,
        {
          displayName: req.body.displayName,
          status: req.body.status,
          isDefault: req.body.isDefault,
          config: req.body.config,
        },
        { type: "user", userId: req.actor.userId },
      );
      if (!updated) {
        res.status(404).json({ error: "Provider vault not found" });
        return;
      }

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "secret_provider_config.updated",
        entityType: "secret_provider_config",
        entityId: updated.id,
        details: {
          provider: updated.provider,
          displayName: updated.displayName,
          status: updated.status,
          isDefault: updated.isDefault,
        },
      });

      res.json(updated);
    },
  );

  router.delete("/secret-provider-configs/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getProviderConfigById(id),
      "Provider vault not found",
    );
    if (!existing) return;

    const removed = await svc.removeProviderConfig(id, {
      type: "user",
      userId: req.actor.userId,
    });
    if (!removed) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "secret_provider_config.removed",
      entityType: "secret_provider_config",
      entityId: removed.id,
      details: {
        provider: removed.provider,
        displayName: removed.displayName,
        remoteDeleted: false,
      },
    });

    res.json(removed);
  });

  router.post("/secret-provider-configs/:id/default", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getProviderConfigById(id),
      "Provider vault not found",
    );
    if (!existing) return;

    const updated = await svc.setDefaultProviderConfig(id, {
      type: "user",
      userId: req.actor.userId,
    });
    if (!updated) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "secret_provider_config.default_set",
      entityType: "secret_provider_config",
      entityId: updated.id,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
        isDefault: updated.isDefault,
      },
    });

    res.json(updated);
  });

  router.post("/secret-provider-configs/:id/health", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(
      req,
      res,
      svc.getProviderConfigById(id),
      "Provider vault not found",
    );
    if (!existing) return;

    const health = await svc.checkProviderConfigHealth(id, {
      type: "user",
      userId: req.actor.userId,
    });
    if (!health) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "secret_provider_config.health_checked",
      entityType: "secret_provider_config",
      entityId: existing.id,
      details: {
        provider: existing.provider,
        status: health.status,
        code: health.details.code,
      },
    });

    res.json(health);
  });
}
