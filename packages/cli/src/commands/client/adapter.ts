import { Command } from "commander";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

export function registerAdapterCommands(program: Command): void {
  const adapter = program
    .command("adapter")
    .description("ACPX-discovered agent operations");

  addCommonClientOptions(
    adapter
      .command("list")
      .description("List ACPX-discovered agents")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/adapters"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

}
