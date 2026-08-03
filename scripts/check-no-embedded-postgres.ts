import path from "node:path";
import { assertExternalDatabaseSubstrate } from "./database-substrate-gate.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

await assertExternalDatabaseSubstrate(repositoryRoot);
console.log("External PostgreSQL-only repository check passed.");
