/** Errors shared by runtime interface compilation, projection, and ingress. */
export class RuntimeInterfaceConflict extends Error {
  readonly code = "runtime_interface_conflict";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeInterfaceConflict";
  }
}

export class RuntimeToolUnavailable extends Error {
  readonly code: string = "runtime_tool_unavailable";

  constructor(readonly toolName: string, message?: string) {
    super(
      message ?? `Tool is not available for the current issue execution: ${toolName}`,
    );
    this.name = "RuntimeToolUnavailable";
  }
}

export class RuntimeToolArgumentsInvalid extends Error {
  readonly code = "runtime_tool_arguments_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeToolArgumentsInvalid";
  }
}
