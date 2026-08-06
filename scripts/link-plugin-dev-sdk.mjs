#!/usr/bin/env node

// Build/test utility for isolated plugin package installs. Normal repository
// plugins are pnpm workspace members and receive this link from pnpm itself.

import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const sdkDir = join(repoRoot, "packages", "plugins", "sdk");

export function linkSdkInto(packageDir) {
  const scopeDir = join(packageDir, "node_modules", "@paperclipai");
  const linkTarget = join(scopeDir, "plugin-sdk");
  const relativeSdkDir = relative(scopeDir, sdkDir);

  mkdirSync(scopeDir, { recursive: true });

  try {
    const stat = lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      if (readlinkSync(linkTarget) === relativeSdkDir) {
        // Already linked to the in-repo SDK; nothing to do.
        return false;
      }
      rmSync(linkTarget, { force: true });
    } else {
      // A real install has already populated @paperclipai/plugin-sdk (e.g. the
      // plugin host did `npm install` of the published tarball). Leave it.
      return false;
    }
  } catch (error) {
    // A missing target is expected (nothing linked yet); surface anything else.
    if (error?.code !== "ENOENT") throw error;
  }

  symlinkSync(relativeSdkDir, linkTarget, "dir");
  return true;
}
