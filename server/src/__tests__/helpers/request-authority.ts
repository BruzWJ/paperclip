import type { Express } from "express";
import {
  createRequestAuthorityBoundary,
  createRequestAuthorityPolicy,
} from "../../http/request-authority.js";

export function installTestRequestAuthority(
  app: Express,
  options: {
    trustProxy?: boolean;
    allowedHostnames?: string[];
  } = {},
): void {
  app.use(createRequestAuthorityBoundary({
    trustProxy: () => options.trustProxy === true,
    policy: createRequestAuthorityPolicy({
      deploymentExposure: "private",
      allowedHostnames: options.allowedHostnames ?? [],
      bindHost: "127.0.0.1",
    }),
  }).middleware);
}
