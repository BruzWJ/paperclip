import {
  createBoardApiKeySchema,
  createCliAuthChallengeSchema,
  isCanonicalUuid,
  resolveCliAuthChallengeSchema,
} from "@paperclipai/shared";
import { badRequest, conflict, notFound, tooManyRequests, unauthorized } from "../errors.js";
import { claimFirstInstanceAdmin } from "../first-admin-claim.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import type { AccessRouteContext } from "./access-route-context.js";
import { assertCompanyAccess, assertCurrentBoardUser } from "./authz.js";
import { assertExactQueryKeys, parseExactBooleanQuery } from "./exact-query.js";

type AccessAuthKeyRoutesContext = Pick<
  AccessRouteContext,
  "db" | "opts" | "requestBaseUrl" | "buildCliAuthApprovalPath" | "router" | "boardAuth" | "inviteRateLimiter"
>;

export function registerAccessAuthAndKeyRoutes(context: AccessAuthKeyRoutesContext): void {
  const { db, opts, requestBaseUrl, buildCliAuthApprovalPath, router, boardAuth, inviteRateLimiter } =
    context;
  router.use("/invites/:token", (req, res, next) => {
    const result = inviteRateLimiter.consume(req.ip || req.socket?.remoteAddress || "unknown");
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      next(
        tooManyRequests("Too many invite requests", {
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
      return;
    }
    next();
  });

  router.post("/bootstrap/claim", async (req, res) => {
    if (opts.deploymentExposure !== "private") {
      throw notFound("Browser first-admin claim is not available");
    }
    if (req.actor.type !== "board" || req.actor.source !== "session" || !req.actor.userId) {
      throw unauthorized("Sign in from a browser session before claiming first admin");
    }

    const claimed = await claimFirstInstanceAdmin(db, {
      userId: req.actor.userId,
    });
    if (claimed.status === "already_claimed") {
      throw conflict("Someone else has already claimed this instance");
    }

    res.json({ claimed: true, userId: claimed.userId });
  });

  router.post("/cli-auth/challenges", validate(createCliAuthChallengeSchema), async (req, res) => {
    const created = await boardAuth.createCliAuthChallenge(req.body);
    const approvalPath = buildCliAuthApprovalPath(created.challenge.id, created.challengeSecret);
    const baseUrl = requestBaseUrl(req);
    res.status(201).json({
      id: created.challenge.id,
      token: created.challengeSecret,
      boardApiToken: created.pendingBoardToken,
      approvalPath,
      approvalUrl: baseUrl ? `${baseUrl}${approvalPath}` : null,
      pollPath: `/cli-auth/challenges/${created.challenge.id}`,
      expiresAt: created.challenge.expiresAt.toISOString(),
      suggestedPollIntervalMs: 1000,
    });
  });

  router.get("/cli-auth/challenges/:id", async (req, res) => {
    const id = req.params.id as string;
    assertExactQueryKeys(req.query, ["token"]);
    const token = req.query.token;
    if (!isCanonicalUuid(id) || typeof token !== "string" || token.length === 0) {
      throw notFound("CLI auth challenge not found");
    }
    const challenge = await boardAuth.describeCliAuthChallenge(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const isSignedInBoardUser =
      req.actor.type === "board" && req.actor.source === "session" && Boolean(req.actor.userId);
    const canApprove =
      isSignedInBoardUser &&
      (challenge.requestedAccess !== "instance_admin_required" || Boolean(req.actor.isInstanceAdmin));

    res.json({
      ...challenge,
      requiresSignIn: !isSignedInBoardUser,
      canApprove,
      currentUserId: req.actor.type === "board" ? req.actor.userId : null,
    });
  });

  router.post(
    "/cli-auth/challenges/:id/approve",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = req.params.id as string;
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw unauthorized("Sign in before approving CLI access");
      }

      const userId = req.actor.userId;
      const approved = await boardAuth.approveCliAuthChallenge(id, req.body.token, userId);

      if (approved.status === "approved") {
        const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
          userId,
          requestedCompanyId: approved.challenge.requestedCompanyId,
          boardApiKeyId: approved.challenge.boardApiKeyId,
        });
        for (const companyId of companyIds) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "board_api_key.created",
            entityType: "user",
            entityId: userId,
            details: {
              boardApiKeyId: approved.challenge.boardApiKeyId,
              requestedAccess: approved.challenge.requestedAccess,
              requestedCompanyId: approved.challenge.requestedCompanyId,
              challengeId: approved.challenge.id,
            },
          });
        }
      }

      res.json({
        approved: approved.status === "approved",
        status: approved.status,
        userId,
        keyId: approved.challenge.boardApiKeyId ?? null,
        expiresAt: approved.challenge.expiresAt.toISOString(),
      });
    },
  );

  router.post(
    "/cli-auth/challenges/:id/cancel",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const cancelled = await boardAuth.cancelCliAuthChallenge(id, req.body.token);
      res.json({
        status: cancelled.status,
        cancelled: cancelled.status === "cancelled",
      });
    },
  );

  router.get("/cli-auth/me", async (req, res) => {
    if (req.actor.type !== "board") {
      throw unauthorized("Board authentication required");
    }
    const userId = req.actor.userId;
    const accessSnapshot = await boardAuth.resolveBoardAccess(userId);
    res.json({
      user: accessSnapshot.user,
      userId,
      isInstanceAdmin: accessSnapshot.isInstanceAdmin,
      companyIds: accessSnapshot.companyIds,
      memberships: accessSnapshot.memberships,
      source: req.actor.source,
      keyId: req.actor.source === "board_key" ? req.actor.keyId : null,
    });
  });

  router.get("/cli-auth/users/:userId", async (req, res) => {
    const userId = req.params.userId as string;
    assertCurrentBoardUser(req, userId);
    const accessSnapshot = await boardAuth.resolveBoardAccess(userId);
    res.json({
      user: accessSnapshot.user,
      userId,
      isInstanceAdmin: accessSnapshot.isInstanceAdmin,
      companyIds: accessSnapshot.companyIds,
      memberships: accessSnapshot.memberships,
      source: req.actor.source,
      keyId: req.actor.source === "board_key" ? (req.actor.keyId ?? null) : null,
    });
  });

  router.get("/board-api-keys", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    assertExactQueryKeys(req.query, ["includeInactive"]);
    const keys = await boardAuth.listBoardApiKeys(req.actor.userId, {
      includeInactive: parseExactBooleanQuery(req.query.includeInactive, "includeInactive"),
    });
    res.json(keys);
  });

  router.post("/board-api-keys", validate(createBoardApiKeySchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    if (req.body.requestedCompanyId) {
      assertCompanyAccess(req, req.body.requestedCompanyId);
    }

    const key = await boardAuth.createNamedBoardApiKey({
      userId: req.actor.userId,
      name: req.body.name,
      expiresAt: req.body.expiresAt === undefined ? undefined : req.body.expiresAt,
    });
    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: req.actor.userId,
      requestedCompanyId: req.body.requestedCompanyId ?? null,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "board_api_key.created",
        entityType: "user",
        entityId: req.actor.userId,
        details: {
          boardApiKeyId: key.id,
          name: key.name,
          requestedCompanyId: req.body.requestedCompanyId ?? null,
          expiresAt: key.expiresAt?.toISOString() ?? null,
        },
      });
    }

    res.status(201).json(key);
  });

  router.delete("/board-api-keys/:keyId", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const keyId = req.params.keyId as string;
    if (!isCanonicalUuid(keyId)) {
      throw badRequest("Invalid board API key ID");
    }
    const key = await boardAuth.getBoardApiKeyForUser(keyId, req.actor.userId);
    if (!key) throw notFound("Board API key not found");
    const revoked = await boardAuth.revokeBoardApiKey(key.id);
    if (!revoked) throw notFound("Board API key not found");

    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: req.actor.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: req.actor.userId,
        details: {
          boardApiKeyId: key.id,
          name: key.name,
          revokedVia: "board_api_key_lifecycle",
        },
      });
    }

    res.json({ ok: true, keyId: key.id });
  });

  router.post("/cli-auth/revoke-current", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key") {
      throw badRequest("Current board API key context is required");
    }
    const key = await boardAuth.assertCurrentBoardKey(req.actor.keyId, req.actor.userId);
    await boardAuth.revokeBoardApiKey(key.id);
    const companyIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: key.userId,
      boardApiKeyId: key.id,
    });
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: key.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: key.userId,
        details: {
          boardApiKeyId: key.id,
          revokedVia: "cli_auth_logout",
        },
      });
    }
    res.json({ revoked: true, keyId: key.id });
  });
}
