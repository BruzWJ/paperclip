import path from "node:path";
import { promises as fs } from "node:fs";
import type { RequestHandler, Response } from "express";
import { parseAcceptEncoding } from "./accept-encoding.js";

type PrecompressedEncoding = "br" | "gzip";

const VARIANT_EXTENSION: Record<PrecompressedEncoding, string> = {
  br: ".br",
  gzip: ".gz",
};

/**
 * Returns the precompressed encodings the client accepts, most preferred
 * first. An explicit `q=0` on an encoding forbids it even when a wildcard
 * would otherwise allow it. Ties in q-value prefer brotli (smaller output).
 */
function negotiatePrecompressedEncodings(value: string | string[] | undefined): PrecompressedEncoding[] {
  const preferences = parseAcceptEncoding(value);
  const findQ = (encoding: PrecompressedEncoding): number =>
    preferences.find((entry) => entry.encoding === encoding)?.q ??
    preferences.find((entry) => entry.encoding === "*")?.q ??
    0;

  const acceptable: Array<{ encoding: PrecompressedEncoding; q: number }> = [];
  const brQ = findQ("br");
  const gzipQ = findQ("gzip");
  if (brQ > 0) acceptable.push({ encoding: "br", q: brQ });
  if (gzipQ > 0) acceptable.push({ encoding: "gzip", q: gzipQ });
  acceptable.sort((a, b) => b.q - a.q || (a.encoding === "br" ? -1 : 1));
  return acceptable.map((entry) => entry.encoding);
}

// Content-Type must reflect the ORIGINAL file (the compressed sidecar is a
// transfer encoding detail). res.type() delegates to the mime lookup express
// itself uses, so /assets stays consistent with express.static.
function setContentTypeForOriginal(res: Response, originalPath: string): void {
  const ext = path.extname(originalPath).slice(1).toLowerCase();
  res.type(ext.length > 0 ? ext : "bin");
  const contentType = res.getHeader("Content-Type");
  if (typeof contentType !== "string" || contentType === "false") {
    res.setHeader("Content-Type", "application/octet-stream");
  }
}

/**
 * Serves precompressed sidecar files (`<asset>.br` / `<asset>.gz`, emitted at
 * build time by the vite precompress plugin) for immutable hashed assets.
 * Falls through to the next middleware (the plain express.static) whenever no
 * sidecar exists or the client does not accept a compressed encoding.
 */
export function staticPrecompressed(assetsDir: string): RequestHandler {
  const root = path.resolve(assetsDir);

  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const encodings = negotiatePrecompressedEncodings(req.headers["accept-encoding"]);
    if (encodings.length === 0) {
      next();
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      next();
      return;
    }
    if (decodedPath.includes("..") || decodedPath.includes("\0")) {
      next();
      return;
    }

    const relativePath = decodedPath.replace(/^\/+/, "");
    if (relativePath.length === 0) {
      next();
      return;
    }
    // Defense in depth: the resolved original must stay inside the root
    // (res.sendFile's own root containment check applies on top of this).
    const originalFile = path.resolve(root, relativePath);
    if (originalFile !== root && !originalFile.startsWith(root + path.sep)) {
      next();
      return;
    }

    for (const encoding of encodings) {
      const variantFile = originalFile + VARIANT_EXTENSION[encoding];
      try {
        const stats = await fs.stat(variantFile);
        if (!stats.isFile()) continue;
      } catch {
        continue;
      }

      setContentTypeForOriginal(res, originalFile);
      res.setHeader("Content-Encoding", encoding);
      res.vary("Accept-Encoding");
      // Same policy as the plain /assets express.static: hashed filenames
      // never change once built, so cache aggressively.
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(relativePath + VARIANT_EXTENSION[encoding], { root }, (error?: Error) => {
        if (!error) return;
        if (!res.headersSent) {
          // The sidecar vanished between stat and send; let the plain
          // express.static serve the uncompressed file instead.
          res.removeHeader("Content-Encoding");
          next();
          return;
        }
        next(error);
      });
      return;
    }

    next();
  };
}
