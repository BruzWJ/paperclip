import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  parseExactHostname,
  parseExactHostnameList,
} from "@paperclipai/shared";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";

export async function addAllowedHostname(
  host: string,
  opts: { config?: string },
): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);

  if (!config) {
    p.log.error(
      `No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`,
    );
    return;
  }

  const exactHostname = parseExactHostname(host);
  const current = parseExactHostnameList(config.server.allowedHostnames ?? []);
  const existed = current.includes(exactHostname);
  if (!existed) current.push(exactHostname);

  config.server.allowedHostnames = current.sort();
  config.$meta.updatedAt = new Date().toISOString();
  config.$meta.source = "configure";
  writeConfig(config, opts.config);

  if (existed) {
    p.log.info(`Hostname ${pc.cyan(exactHostname)} is already allowed.`);
  } else {
    p.log.success(`Added allowed hostname: ${pc.cyan(exactHostname)}`);
    p.log.message(
      pc.dim("Restart the Paperclip server for this change to take effect."),
    );
  }

  if (config.server.exposure !== "private") {
    p.log.message(
      pc.dim("Note: allowed hostnames are enforced only for private exposure."),
    );
  }
}
