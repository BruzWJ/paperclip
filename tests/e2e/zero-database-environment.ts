import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const inheritedEnvironmentKeys = new Set([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "LANG",
  "LANGUAGE",
  "LD_LIBRARY_PATH",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "SHELL",
  "SYSTEMROOT",
  "TERM",
  "TZ",
  "USER",
  "USERNAME",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
]);

const inheritedEnvironmentPrefixes = [
  "LC_",
  "PLAYWRIGHT_",
  "PW_",
];

const paperclipPlaywrightEnvironmentKeys = new Set([
  "PAPERCLIP_E2E_PORT",
  "PAPERCLIP_PLAYWRIGHT_CHANNEL",
]);

function resolveInheritedPlaywrightBrowserPath(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (environment.PLAYWRIGHT_BROWSERS_PATH !== undefined) {
    return environment.PLAYWRIGHT_BROWSERS_PATH;
  }

  const home = environment.HOME ?? environment.USERPROFILE;
  if (!home) return undefined;

  if (process.platform === "win32") {
    return path.join(
      environment.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "ms-playwright",
    );
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches", "ms-playwright");
  }
  return path.join(
    environment.XDG_CACHE_HOME ?? path.join(home, ".cache"),
    "ms-playwright",
  );
}

/**
 * Browser tests inherit only process mechanics needed by Playwright and the
 * two explicit Paperclip test selectors. Database/config/dotenv selectors and
 * caller preloads cannot cross into workers or the Vite child.
 */
export function installZeroDatabasePlaywrightEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const playwrightBrowsersPath =
    resolveInheritedPlaywrightBrowserPath(environment);
  const testRoot = mkdtempSync(
    path.join(os.tmpdir(), `pcpw-${process.pid}-`),
  );
  const isolated: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalizedKey = key.toUpperCase();
    if (
      value !== undefined
      && (
        inheritedEnvironmentKeys.has(normalizedKey)
        || paperclipPlaywrightEnvironmentKeys.has(normalizedKey)
        || inheritedEnvironmentPrefixes.some((prefix) =>
          normalizedKey.startsWith(prefix)
        )
      )
    ) {
      isolated[key] = value;
    }
  }

  Object.assign(isolated, {
    HOME: path.join(testRoot, "home"),
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "paperclip-home"),
    TEMP: path.join(testRoot, "tmp"),
    TMP: path.join(testRoot, "tmp"),
    TMPDIR: path.join(testRoot, "tmp"),
  });
  if (playwrightBrowsersPath !== undefined) {
    isolated.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  }

  for (const key of Object.keys(environment)) delete environment[key];
  Object.assign(environment, isolated);

  mkdirSync(isolated.HOME!, { recursive: true });
  mkdirSync(isolated.PAPERCLIP_HOME!, { recursive: true });
  mkdirSync(isolated.TMPDIR!, { recursive: true });
  process.once("exit", () => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  return { ...isolated };
}
