import {
  createUserSecretDefinitionSchema,
  createUserSecretValueSchema,
  rotateUserSecretValueSchema,
  updateUserSecretDefinitionSchema,
  updateUserSecretValueSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import type { SecretRouteContext } from "./secret-route-context.js";

type UserSecretRoutesContext = Pick<
  SecretRouteContext,
  "router" | "db" | "svc" | "defaultProvider" | "secretDefinitionAdminUserId" | "currentUserSecretOwnerId"
>;

export function registerUserSecretRoutes(context: UserSecretRoutesContext): void {
  const { router, db, svc, defaultProvider, secretDefinitionAdminUserId, currentUserSecretOwnerId } = context;

  router.get("/companies/:companyId/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const secrets = await svc.list(companyId);
    res.json(secrets);
  });

  router.get("/companies/:companyId/user-secret-definitions", async (req, res) => {
    const companyId = req.params.companyId as string;
    secretDefinitionAdminUserId(req, companyId);
    res.json(await svc.listUserSecretDefinitions(companyId));
  });

  router.post(
    "/companies/:companyId/user-secret-definitions",
    validate(createUserSecretDefinitionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actorUserId = secretDefinitionAdminUserId(req, companyId);

      const created = await svc.createUserSecretDefinition(
        companyId,
        {
          key: req.body.key,
          name: req.body.name,
          description: req.body.description,
          status: req.body.status,
          provider: req.body.provider ?? defaultProvider,
          providerConfigId: req.body.providerConfigId,
          managedMode: req.body.managedMode,
          providerMetadata: req.body.providerMetadata,
          usageGuidance: req.body.usageGuidance,
        },
        { type: "user", userId: actorUserId },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "user_secret_definition.created",
        entityType: "user_secret_definition",
        entityId: created.id,
        details: { key: created.key, provider: created.provider },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/user-secret-definitions/:definitionId",
    validate(updateUserSecretDefinitionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const definitionId = req.params.definitionId as string;
      const actorUserId = secretDefinitionAdminUserId(req, companyId);

      const updated = await svc.updateUserSecretDefinition(
        companyId,
        definitionId,
        {
          key: req.body.key,
          name: req.body.name,
          description: req.body.description,
          status: req.body.status,
          providerConfigId: req.body.providerConfigId,
          providerMetadata: req.body.providerMetadata,
          usageGuidance: req.body.usageGuidance,
        },
        { type: "user", userId: actorUserId },
      );
      if (!updated) {
        res.status(404).json({ error: "User secret definition not found" });
        return;
      }
      const activityAction =
        req.body.status === "deleted" ? "user_secret_definition.deleted" : "user_secret_definition.updated";

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: activityAction,
        entityType: "user_secret_definition",
        entityId: updated.id,
        details: { key: updated.key, status: updated.status },
      });

      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/user-secret-definitions/:definitionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const definitionId = req.params.definitionId as string;
    const actorUserId = secretDefinitionAdminUserId(req, companyId);

    const removed = await svc.removeUserSecretDefinition(companyId, definitionId, {
      type: "user",
      userId: actorUserId,
    });
    if (!removed) {
      res.status(404).json({ error: "User secret definition not found" });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId,
      action: "user_secret_definition.deleted",
      entityType: "user_secret_definition",
      entityId: removed.id,
      details: { key: removed.key },
    });

    res.json({ ok: true });
  });

  router.get("/companies/:companyId/user-secret-definitions/:definitionId/coverage", async (req, res) => {
    const companyId = req.params.companyId as string;
    const definitionId = req.params.definitionId as string;
    secretDefinitionAdminUserId(req, companyId);
    res.json(await svc.getUserSecretDefinitionCoverage(companyId, definitionId));
  });

  router.get("/companies/:companyId/users/:userId/secrets", async (req, res) => {
    const companyId = req.params.companyId as string;
    const ownerUserId = currentUserSecretOwnerId(req, companyId, req.params.userId as string);
    res.json(await svc.listCurrentUserSecretValues(companyId, ownerUserId));
  });

  router.post(
    "/companies/:companyId/users/:userId/secrets",
    validate(createUserSecretValueSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const ownerUserId = currentUserSecretOwnerId(req, companyId, req.params.userId as string);
      const created = await svc.createCurrentUserSecretValue(
        companyId,
        ownerUserId,
        {
          definitionId: req.body.definitionId,
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { type: "user", userId: ownerUserId },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.created",
        entityType: "secret",
        entityId: created.id,
        details: {
          userSecretDefinitionId: created.userSecretDefinitionId,
          ownerUserId: created.ownerUserId,
          provider: created.provider,
        },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/users/:userId/secrets/:secretId",
    validate(updateUserSecretValueSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const secretId = req.params.secretId as string;
      const ownerUserId = currentUserSecretOwnerId(req, companyId, req.params.userId as string);
      const updated = await svc.updateCurrentUserSecretValue(
        companyId,
        ownerUserId,
        secretId,
        {
          status: req.body.status,
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { type: "user", userId: ownerUserId },
      );
      if (!updated) {
        res.status(404).json({ error: "User secret value not found" });
        return;
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.updated",
        entityType: "secret",
        entityId: updated.id,
        details: {
          userSecretDefinitionId: updated.userSecretDefinitionId,
          ownerUserId: updated.ownerUserId,
          status: updated.status,
        },
      });

      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/users/:userId/secrets/:secretId/rotate",
    validate(rotateUserSecretValueSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const secretId = req.params.secretId as string;
      const ownerUserId = currentUserSecretOwnerId(req, companyId, req.params.userId as string);
      const rotated = await svc.rotateCurrentUserSecretValue(
        companyId,
        ownerUserId,
        secretId,
        {
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { type: "user", userId: ownerUserId },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.rotated",
        entityType: "secret",
        entityId: rotated.id,
        details: {
          userSecretDefinitionId: rotated.userSecretDefinitionId,
          ownerUserId: rotated.ownerUserId,
          version: rotated.latestVersion,
        },
      });

      res.json(rotated);
    },
  );

  router.delete("/companies/:companyId/users/:userId/secrets/:secretId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const secretId = req.params.secretId as string;
    const ownerUserId = currentUserSecretOwnerId(req, companyId, req.params.userId as string);
    const removed = await svc.removeCurrentUserSecretValue(companyId, ownerUserId, secretId, {
      type: "user",
      userId: ownerUserId,
    });
    if (!removed) {
      res.status(404).json({ error: "User secret value not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: ownerUserId,
      action: "user_secret_value.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: {
        userSecretDefinitionId: removed.userSecretDefinitionId,
        ownerUserId: removed.ownerUserId,
      },
    });

    res.json({ ok: true });
  });
}
