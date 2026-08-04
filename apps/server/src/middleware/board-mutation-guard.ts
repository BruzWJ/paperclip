import type { Request, RequestHandler } from "express";
import {
  canonicalizeBrowserOrigin,
  requireRequestAuthority,
} from "../http/request-authority.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isTrustedBoardMutationRequest(req: Request) {
  const requestOrigin = requireRequestAuthority(req).origin;
  const origin = canonicalizeBrowserOrigin(req.header("origin"));
  if (origin === requestOrigin) return true;

  const refererOrigin = canonicalizeBrowserOrigin(
    req.header("referer"),
    { allowPath: true },
  );
  if (refererOrigin === requestOrigin) return true;

  return false;
}

export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Board API keys are derivative non-browser credentials, so they do not
    // carry browser Origin/Referer headers.
    if (req.actor.source === "board_key") {
      next();
      return;
    }

    if (!isTrustedBoardMutationRequest(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
