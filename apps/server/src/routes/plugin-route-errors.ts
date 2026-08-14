import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginBridgeError } from "@paperclipai/shared";
import type { Request, Response } from "express";
import { attachErrorContext } from "../middleware/error-handler.js";

export function mapRpcErrorToBridgeError(error: unknown): PluginBridgeError {
  if (error instanceof JsonRpcCallError) {
    const code: PluginBridgeError["code"] =
      error.code === PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE
        ? "WORKER_UNAVAILABLE"
        : error.code === PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED
          ? "CAPABILITY_DENIED"
          : error.code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED
            ? "INVOCATION_SCOPE_DENIED"
            : error.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT
              ? "TIMEOUT"
              : error.code === PLUGIN_RPC_ERROR_CODES.WORKER_ERROR ||
                  error.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED ||
                  error.code === PLUGIN_RPC_ERROR_CODES.UNKNOWN
                ? "WORKER_ERROR"
                : "UNKNOWN";
    return {
      code,
      message: error.message,
      ...(error.data === undefined ? {} : { details: error.data }),
    };
  }
  return {
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function sendPluginBridgeError(
  req: Request,
  res: Response,
  status: number,
  error: unknown,
  metadata: Record<string, unknown>,
): void {
  const bridgeError = mapRpcErrorToBridgeError(error);
  const rootError = error instanceof Error ? error : new Error(String(error));
  attachErrorContext(
    req,
    res,
    {
      message: bridgeError.message,
      stack: rootError.stack,
      name: rootError.name,
      details: {
        ...metadata,
        bridgeCode: bridgeError.code,
        bridgeDetails: bridgeError.details,
      },
    },
    rootError,
  );
  res.status(status).json(bridgeError);
}
