import { z } from "zod";

export type JsonSchema = Record<string, unknown>;
export type OpenApiResponse = Record<string, unknown>;
export type OpenApiPathRegistration = {
  method: string;
  path: string;
  request?: {
    params?: z.ZodTypeAny;
    query?: z.ZodTypeAny;
    body?: {
      content: Record<string, { schema: unknown }>;
      required?: boolean;
    };
  };
  responses?: Record<string, OpenApiResponse>;
  [key: string]: unknown;
};

export const zodTypeName = (schema: z.ZodTypeAny) => schema._def.typeName as string;

export function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const typeName = zodTypeName(schema);
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch") {
    return unwrapSchema(schema._def.innerType);
  }
  if (typeName === "ZodEffects") {
    return unwrapSchema(schema._def.schema);
  }
  return schema;
}

export function isOptionalSchema(schema: z.ZodTypeAny): boolean {
  const typeName = zodTypeName(schema);
  if (typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodCatch") {
    return true;
  }
  if (typeName === "ZodEffects") {
    return isOptionalSchema(schema._def.schema);
  }
  if (typeName === "ZodNullable") {
    return isOptionalSchema(schema._def.innerType);
  }
  return false;
}

export function applyStringChecks(jsonSchema: JsonSchema, checks: Array<Record<string, unknown>>) {
  for (const check of checks) {
    if (check.kind === "min") jsonSchema.minLength = check.value;
    if (check.kind === "max") jsonSchema.maxLength = check.value;
    if (check.kind === "email") jsonSchema.format = "email";
    if (check.kind === "url") jsonSchema.format = "uri";
    if (check.kind === "uuid") jsonSchema.format = "uuid";
    if (check.kind === "datetime") jsonSchema.format = "date-time";
    if (check.kind === "regex" && check.regex instanceof RegExp) {
      jsonSchema.pattern = check.regex.source;
    }
  }
}

export function applyNumberChecks(jsonSchema: JsonSchema, checks: Array<Record<string, unknown>>) {
  for (const check of checks) {
    if (check.kind === "int") jsonSchema.type = "integer";
    if (check.kind === "min") {
      jsonSchema.minimum = check.value;
      if (!check.inclusive) jsonSchema.exclusiveMinimum = true;
    }
    if (check.kind === "max") {
      jsonSchema.maximum = check.value;
      if (!check.inclusive) jsonSchema.exclusiveMaximum = true;
    }
  }
}

export function zodToOpenApiSchema(schema: z.ZodTypeAny): JsonSchema {
  const unwrapped = unwrapSchema(schema);
  const typeName = zodTypeName(unwrapped);

  if (typeName === "ZodString") {
    const jsonSchema: JsonSchema = { type: "string" };
    applyStringChecks(jsonSchema, unwrapped._def.checks ?? []);
    return jsonSchema;
  }

  if (typeName === "ZodNumber") {
    const jsonSchema: JsonSchema = { type: "number" };
    applyNumberChecks(jsonSchema, unwrapped._def.checks ?? []);
    return jsonSchema;
  }

  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodDate") return { type: "string", format: "date-time" };
  if (typeName === "ZodAny" || typeName === "ZodUnknown") return {};

  if (typeName === "ZodLiteral") {
    const value = unwrapped._def.value;
    return { type: typeof value, enum: [value] };
  }

  if (typeName === "ZodEnum") {
    return { type: "string", enum: unwrapped._def.values };
  }

  if (typeName === "ZodNativeEnum") {
    const values = Object.values(unwrapped._def.values).filter(
      (value) => typeof value === "string" || typeof value === "number",
    );
    return { enum: Array.from(new Set(values)) };
  }

  if (typeName === "ZodArray") {
    return { type: "array", items: zodToOpenApiSchema(unwrapped._def.type) };
  }

  if (typeName === "ZodRecord") {
    return {
      type: "object",
      additionalProperties: zodToOpenApiSchema(unwrapped._def.valueType),
    };
  }

  if (typeName === "ZodNullable") {
    return { ...zodToOpenApiSchema(unwrapped._def.innerType), nullable: true };
  }

  if (typeName === "ZodUnion") {
    return {
      oneOf: unwrapped._def.options.map((option: z.ZodTypeAny) => zodToOpenApiSchema(option)),
    };
  }

  if (typeName === "ZodDiscriminatedUnion") {
    return {
      oneOf: Array.from(unwrapped._def.options.values()).map((option) =>
        zodToOpenApiSchema(option as z.ZodTypeAny),
      ),
    };
  }

  if (typeName === "ZodIntersection") {
    return {
      allOf: [zodToOpenApiSchema(unwrapped._def.left), zodToOpenApiSchema(unwrapped._def.right)],
    };
  }

  if (typeName === "ZodObject") {
    const shape = unwrapped._def.shape();
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const propertySchema = value as z.ZodTypeAny;
      properties[key] = zodToOpenApiSchema(propertySchema);
      if (!isOptionalSchema(propertySchema)) required.push(key);
    }
    const jsonSchema: JsonSchema = { type: "object", properties };
    if (required.length > 0) jsonSchema.required = required;
    if (unwrapped._def.unknownKeys === "strict") {
      jsonSchema.additionalProperties = false;
    }
    return jsonSchema;
  }

  return {};
}

export function normalizeContent(content: Record<string, { schema: unknown }>) {
  return Object.fromEntries(
    Object.entries(content).map(([contentType, media]) => [
      contentType,
      {
        ...media,
        schema: isZodSchema(media.schema) ? zodToOpenApiSchema(media.schema) : media.schema,
      },
    ]),
  );
}

export function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return Boolean(
    value &&
    typeof value === "object" &&
    "_def" in value &&
    typeof (value as z.ZodTypeAny).safeParse === "function",
  );
}

export function normalizeResponses(responses: Record<string, OpenApiResponse> = {}) {
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      const content = response.content as Record<string, { schema: unknown }> | undefined;
      return [
        status,
        content
          ? {
              ...response,
              content: normalizeContent(content),
            }
          : response,
      ];
    }),
  );
}

export function parametersFromSchema(schema: z.ZodTypeAny, location: "path" | "query") {
  const objectSchema = unwrapSchema(schema);
  if (zodTypeName(objectSchema) !== "ZodObject") return [];
  const shape = objectSchema._def.shape();
  return Object.entries(shape).map(([name, value]) => ({
    name,
    in: location,
    required: location === "path" ? true : !isOptionalSchema(value as z.ZodTypeAny),
    schema: zodToOpenApiSchema(value as z.ZodTypeAny),
  }));
}

export class OpenAPIRegistry {
  private readonly schemas: Record<string, JsonSchema> = {};
  private readonly paths: Array<OpenApiPathRegistration> = [];

  register(name: string, schema: z.ZodTypeAny) {
    this.schemas[name] = zodToOpenApiSchema(schema);
    return { $ref: `#/components/schemas/${name}` };
  }

  registerPath(pathRegistration: OpenApiPathRegistration) {
    this.paths.push(pathRegistration);
  }

  buildPaths() {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const { method, path, request, responses, ...operation } of this.paths) {
      const normalizedOperation: Record<string, unknown> = {
        ...operation,
        responses: normalizeResponses(responses),
      };
      if (request?.params) {
        normalizedOperation.parameters = parametersFromSchema(request.params, "path");
      }
      if (request?.query) {
        normalizedOperation.parameters = [
          ...((normalizedOperation.parameters as unknown[]) ?? []),
          ...parametersFromSchema(request.query, "query"),
        ];
      }
      if (request?.body) {
        normalizedOperation.requestBody = {
          ...request.body,
          content: normalizeContent(request.body.content),
        };
      }
      paths[path] ??= {};
      paths[path][method] = normalizedOperation;
    }
    return paths;
  }

  buildComponents() {
    return { schemas: this.schemas };
  }
}
