import type { Request, RequestHandler } from "express";
import {
  assertRunBearerRejectedByGenericApi,
  PromptCapabilityAuthenticationError,
} from "../services/prompt-capability-gateway.js";

export function bearerCredentialFromRequest(req: Request): string | null {
  const authorization = req.header("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function rejectRunInterfaceBearerFromGenericApi(): RequestHandler {
  return (req, res, next) => {
    const credential = bearerCredentialFromRequest(req);
    if (!credential) {
      next();
      return;
    }
    try {
      assertRunBearerRejectedByGenericApi(credential);
      next();
    } catch (error) {
      if (!(error instanceof PromptCapabilityAuthenticationError)) {
        next(error);
        return;
      }
      res.status(401).json({
        error: error.message,
        code: error.code,
      });
    }
  };
}
