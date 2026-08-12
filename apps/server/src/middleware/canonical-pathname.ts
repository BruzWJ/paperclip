import type { RequestHandler } from "express";
import {
  isCanonicalEncodedPathname,
  isCanonicalUrlSearch,
  rawPathnameFromHref,
  rawSearchFromHref,
} from "@paperclipai/shared/canonical-pathname";

export function canonicalRequestTarget(): RequestHandler {
  return (req, res, next) => {
    if (
      !isCanonicalEncodedPathname(rawPathnameFromHref(req.originalUrl)) ||
      !isCanonicalUrlSearch(rawSearchFromHref(req.originalUrl))
    ) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  };
}
