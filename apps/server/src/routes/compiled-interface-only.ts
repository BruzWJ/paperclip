import type { RequestHandler } from "express";

export function denyGenericAgentRest(surface: string): RequestHandler {
  return (req, res, next) => {
    if (req.actor.type === "agent") {
      res.status(403).json({
        error:
          `Agent credentials cannot access the generic ${surface} API; use the run-scoped compiled interface`,
        code: "compiled_run_interface_required",
      });
      return;
    }
    next();
  };
}
