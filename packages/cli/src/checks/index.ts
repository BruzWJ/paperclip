export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  guidance?: string;
}

export { configCheck } from "./config-check.js";
export { authCheck } from "./auth-check.js";
export { databaseCheck } from "./database-check.js";
export { logCheck } from "./log-check.js";
export { portCheck } from "./port-check.js";
export { secretsCheck } from "./secrets-check.js";
export { storageCheck } from "./storage-check.js";
