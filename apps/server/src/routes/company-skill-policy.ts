import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { evaluateSkillPolicySchema, replaceSkillPolicySchema } from "@paperclipai/shared";
import { ZodError, type ZodSchema } from "zod";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "../services/access.js";
import { companySkillPolicyService, type SkillPolicyPrincipal } from "../services/company-skill-policy.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function companySkillPolicyRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const policies = companySkillPolicyService(db);

  function validatePolicyBody(schema: ZodSchema) {
    return (req: Request, _res: Response, next: NextFunction) => {
      try {
        req.body = schema.parse(req.body);
        next();
      } catch (error) {
        if (error instanceof ZodError) {
          next(unprocessable("Invalid skill policy document", {
            code: "skill_policy_validation_failed",
            issues: error.issues,
          }));
          return;
        }
        next(error);
      }
    };
  }

  async function assertCanAdministerPolicy(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.isInstanceAdmin) return;
    if (await access.canUser(companyId, req.actor.userId, "users:manage_permissions")) return;
    throw forbidden("Skill policy administration authority required", {
      code: "skill_policy_admin_required",
      remediation: "Ask a company administrator to manage the skill policy.",
    });
  }

  async function currentPrincipal(req: Request, companyId: string): Promise<SkillPolicyPrincipal> {
    assertCompanyAccess(req, companyId);
    return { type: "board", id: req.actor.userId };
  }

  router.get("/companies/:companyId/skill-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await policies.get(companyId));
  });

  router.put(
    "/companies/:companyId/skill-policy",
    validatePolicyBody(replaceSkillPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanAdministerPolicy(req, companyId);
      assertBoard(req);
      const { expectedRevision, ...policy } = req.body;
      res.json(await policies.replace({
        companyId,
        expectedRevision,
        policy,
        activity: {
          actorType: "user",
          actorId: req.actor.userId,
        },
      }));
    },
  );

  router.delete("/companies/:companyId/skill-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertCanAdministerPolicy(req, companyId);
    assertBoard(req);
    res.json(await policies.reset({
      companyId,
      activity: {
        actorType: "user",
        actorId: req.actor.userId,
      },
    }));
  });

  router.post(
    "/companies/:companyId/skill-policy/evaluate",
    validatePolicyBody(evaluateSkillPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      let principal: SkillPolicyPrincipal;
      if (req.body.principal) {
        await assertCanAdministerPolicy(req, companyId);
        principal = await policies.resolveAgentPrincipal(companyId, req.body.principal.agentId);
      } else {
        principal = await currentPrincipal(req, companyId);
      }
      res.json(await policies.evaluate({
        companyId,
        principal,
        action: req.body.action,
        resource: req.body.resource,
      }));
    },
  );

  return router;
}
