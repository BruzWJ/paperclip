import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const repositoryEnv = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(repositoryEnv)) loadEnvFile(repositoryEnv);

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
