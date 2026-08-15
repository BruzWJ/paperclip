import * as p from "@clack/prompts";
import pc from "picocolors";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import {
  configCheck,
  databaseCheck,
  authCheck,
  logCheck,
  portCheck,
  secretsCheck,
  storageCheck,
  type CheckResult,
} from "../checks/index.js";
import { loadPaperclipEnvironmentFiles } from "../config/env.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

const STATUS_ICON = {
  pass: pc.green("✓"),
  warn: pc.yellow("!"),
  fail: pc.red("✗"),
} as const;

export async function doctor(opts: {
  config?: string;
}): Promise<{ passed: number; warned: number; failed: number }> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip doctor ")));

  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvironmentFiles(configPath);
  const results: CheckResult[] = [];

  // 1. Config check (must pass before others)
  const cfgResult = configCheck(opts.config);
  results.push(cfgResult);
  printResult(cfgResult);

  if (cfgResult.status === "fail") {
    return printSummary(results);
  }

  let config: PaperclipConfig;
  try {
    config = readConfig(opts.config)!;
  } catch (err) {
    const readResult: CheckResult = {
      name: "Config file",
      status: "fail",
      message: `Could not read config: ${err instanceof Error ? err.message : String(err)}`,
      guidance: "Run `paperclipai configure --section database` or create a fresh configuration with `paperclipai onboard`",
    };
    results.push(readResult);
    printResult(readResult);
    return printSummary(results);
  }

  // 2. Canonical Better Auth check
  const authResult = authCheck(config);
  results.push(authResult);
  printResult(authResult);

  // 3. Secrets adapter check
  const secretsResult = secretsCheck(config, configPath);
  results.push(secretsResult);
  printResult(secretsResult);

  // 4. Storage check
  const storageResult = storageCheck(config, configPath);
  results.push(storageResult);
  printResult(storageResult);

  // 5. Database check
  const databaseResult = await databaseCheck(config, configPath);
  results.push(databaseResult);
  printResult(databaseResult);

  // 6. Log directory check
  const logResult = logCheck(config, configPath);
  results.push(logResult);
  printResult(logResult);

  // 7. Port check
  const portResult = await portCheck(config);
  results.push(portResult);
  printResult(portResult);

  // Summary
  return printSummary(results);
}

function printResult(result: CheckResult): void {
  const icon = STATUS_ICON[result.status];
  p.log.message(`${icon} ${pc.bold(result.name)}: ${result.message}`);
  if (result.status !== "pass" && result.guidance) {
    p.log.message(`  ${pc.dim(result.guidance)}`);
  }
}

function printSummary(results: CheckResult[]): { passed: number; warned: number; failed: number } {
  const passed = results.filter((r) => r.status === "pass").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  const parts: string[] = [];
  parts.push(pc.green(`${passed} passed`));
  if (warned) parts.push(pc.yellow(`${warned} warnings`));
  if (failed) parts.push(pc.red(`${failed} failed`));

  p.note(parts.join(", "), "Summary");

  if (failed > 0) {
    p.outro(pc.red("Some checks failed. Fix the failures above and re-run doctor."));
  } else if (warned > 0) {
    p.outro(pc.yellow("All critical checks passed with some warnings."));
  } else {
    p.outro(pc.green("All checks passed!"));
  }

  return { passed, warned, failed };
}
