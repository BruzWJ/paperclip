import fs from "node:fs";
import {
  paperclipConfigSchema,
  validationDetails,
  type PaperclipConfig,
} from "@paperclipai/shared";
import { ZodError } from "zod";
import { resolvePaperclipConfigPath } from "./paths.js";

function formatConfigValidationError(error: ZodError): string {
  return validationDetails(error)
    .map((detail) => {
      const detailPath = detail.path.length > 0 ? detail.path.join(".") : "<root>";
      return `${detailPath}: ${detail.message}`;
    })
    .join("; ");
}

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  if (!fs.existsSync(configPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Paperclip config at ${configPath}: failed to read or parse JSON: ${reason}`);
  }

  try {
    return paperclipConfigSchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid Paperclip config at ${configPath}: ${formatConfigValidationError(error)}`);
    }

    throw error;
  }
}
