import { Command } from "commander";
import { onboard } from "./commands/onboard.js";
import { doctor } from "./commands/doctor.js";
import { envCommand } from "./commands/env.js";
import { configure } from "./commands/configure.js";
import { addAllowedHostname } from "./commands/allowed-hostname.js";
import { runCommand } from "./commands/run.js";
import { bootstrapAdminInvite } from "./commands/auth-bootstrap-admin.js";
import { registerEnvLabCommands } from "./commands/env-lab.js";
import { registerContextCommands } from "./commands/client/context.js";
import { registerCompanyCommands } from "./commands/client/company.js";
import { registerIssueCommands } from "./commands/client/issue.js";
import { registerAgentCommands } from "./commands/client/agent.js";
import { registerProjectCommands } from "./commands/client/project.js";
import { registerGoalCommands } from "./commands/client/goal.js";
import { registerApprovalCommands } from "./commands/client/approval.js";
import { registerActivityCommands } from "./commands/client/activity.js";
import { registerDashboardCommands } from "./commands/client/dashboard.js";
import { registerRoutineCommands } from "./commands/routines.js";
import { registerPipelineCommands } from "./commands/pipelines.js";
import { registerSecretCommands } from "./commands/client/secrets.js";
import { registerCloudCommands } from "./commands/client/cloud.js";
import { registerSkillsCommands } from "./commands/client/skills.js";
import { registerTeamCommands } from "./commands/client/teams.js";
import { applyDataDirOverride, type DataDirOptionLike } from "./config/data-dir.js";
import { loadPaperclipEnvFile } from "./config/env.js";
import { initTelemetryFromConfigFile, flushTelemetry } from "./telemetry.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { registerPluginCommands } from "./commands/client/plugin.js";
import { registerClientAuthCommands } from "./commands/client/auth.js";
import { registerConnectCommand } from "./commands/client/connect.js";
import { registerTokenCommands } from "./commands/client/token.js";
import { registerPromptCommands } from "./commands/client/prompt.js";
import { registerRunCommands } from "./commands/client/run.js";
import { registerCostCommands } from "./commands/client/cost.js";
import { registerWorkspaceCommands } from "./commands/client/workspace.js";
import { registerAccessCommands } from "./commands/client/access.js";
import { registerRoutineApiCommands } from "./commands/client/routine-api.js";
import { registerAdapterCommands } from "./commands/client/adapter.js";
import { registerAssetCommands } from "./commands/client/asset.js";
import { registerSkillCommands } from "./commands/client/skill.js";
import { cliVersion } from "./version.js";

const program = new Command();
const DATA_DIR_OPTION_HELP =
  "Paperclip data directory root (isolates state from ~/.paperclip)";

program
  .name("paperclipai")
  .description("Paperclip CLI — setup, diagnose, and configure your instance")
  .version(cliVersion);

program.hook("preAction", (_thisCommand, actionCommand) => {
  const options = actionCommand.optsWithGlobals() as DataDirOptionLike;
  const optionNames = new Set(actionCommand.options.map((option) => option.attributeName()));
  applyDataDirOverride(options, {
    hasConfigOption: optionNames.has("config"),
    hasContextOption: optionNames.has("context"),
  });
  loadPaperclipEnvFile(options.config);
  initTelemetryFromConfigFile(options.config);
});

program
  .command("onboard")
  .description("Interactive first-run setup wizard")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--bind <mode>", "Quickstart reachability preset (loopback, lan, tailnet)")
  .option("-y, --yes", "Accept private-loopback quickstart defaults unless --bind is set, then start immediately", false)
  .option("--run", "Start Paperclip immediately after saving config", false)
  .action(onboard);

program
  .command("doctor")
  .description("Run diagnostic checks on your Paperclip setup")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(async (opts) => {
    await doctor(opts);
  });

program
  .command("env")
  .description("Print environment variables for deployment")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(envCommand);

program
  .command("configure")
  .description("Update configuration sections")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-s, --section <section>", "Section to configure (database, logging, server, storage, secrets)")
  .action(configure);

program
  .command("allowed-hostname")
  .description("Allow a hostname for private exposure")
  .argument("<host>", "Hostname to allow (for example dotta-macbook-pro)")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(addAllowedHostname);

const run = program
  .command("run")
  .description("Bootstrap local setup (onboard + doctor) and run Paperclip")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-i, --instance <id>", "Local instance id (default: default)")
  .option("--bind <mode>", "On first run, use onboarding reachability preset (loopback, lan, tailnet)")
  .action(async (opts) => {
    await runCommand(opts);
  });

registerRunCommands(run);

registerContextCommands(program);
registerConnectCommand(program);
registerCompanyCommands(program);
registerIssueCommands(program);
registerAgentCommands(program);
registerProjectCommands(program);
registerGoalCommands(program);
registerTokenCommands(program);
registerPromptCommands(program);
registerApprovalCommands(program);
registerActivityCommands(program);
registerDashboardCommands(program);
registerCostCommands(program);
registerWorkspaceCommands(program);
registerAccessCommands(program);
registerRoutineApiCommands(program);
registerAdapterCommands(program);
registerAssetCommands(program);
registerSkillCommands(program);
registerRoutineCommands(program);
registerPipelineCommands(program);
registerSecretCommands(program);
registerCloudCommands(program);
registerSkillsCommands(program);
registerTeamCommands(program);
registerWorktreeCommands(program);
registerEnvLabCommands(program);
registerPluginCommands(program);

const auth = program.command("auth").description("Authentication and bootstrap utilities");

auth
  .command("bootstrap-admin")
  .description("Create a one-time bootstrap invite URL for first instance admin")
  .option("-c, --config <path>", "Path to config file")
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--expires-hours <hours>", "Invite expiration window in hours", (value) => Number(value))
  .option("--base-url <url>", "Public base URL used to print invite link")
  .action(bootstrapAdminInvite);

registerClientAuthCommands(auth);

async function main(): Promise<void> {
  let failed = false;
  try {
    await program.parseAsync();
  } catch (err) {
    failed = true;
    console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await flushTelemetry();
  }

  if (failed) {
    process.exit(1);
  }
}

void main();
