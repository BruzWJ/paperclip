import type { CompanyPortabilityAdapterOverride } from "@paperclipai/shared";

function parseAssignment(
  raw: string,
  flag: string,
  format: string,
): [string, string] {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Invalid ${flag} "${raw}". Use ${format}.`);
  }
  return [raw.slice(0, separator), raw.slice(separator + 1)];
}

export function parseExplicitAdapterOverrides(
  typeValues: string[] | undefined,
  configValues: string[] | undefined,
): Record<string, CompanyPortabilityAdapterOverride> | undefined {
  if (
    (!typeValues || typeValues.length === 0) &&
    (!configValues || configValues.length === 0)
  ) {
    return undefined;
  }

  const result: Record<
    string,
    {
      adapterType: string;
      adapterConfig?: Record<string, unknown>;
    }
  > = {};
  for (const raw of typeValues ?? []) {
    const [slug, adapterType] = parseAssignment(
      raw,
      "--adapter-override",
      "slug=type",
    );
    if (!slug || !adapterType) {
      throw new Error(`Invalid --adapter-override "${raw}". Use slug=type.`);
    }
    if (result[slug]) {
      throw new Error(`Duplicate --adapter-override for agent slug "${slug}".`);
    }
    result[slug] = { adapterType };
  }

  function parseJsonObject(
    raw: string,
    slug: string,
    flag: "--adapter-config",
  ): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Invalid ${flag} for "${slug}". Configuration must be a JSON object.`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `Invalid ${flag} for "${slug}". Configuration must be a JSON object.`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  const seenConfigSlugs = new Set<string>();
  for (const raw of configValues ?? []) {
    const [slug, rawConfig] = parseAssignment(
      raw,
      "--adapter-config",
      "slug=json",
    );
    if (!slug || !rawConfig) {
      throw new Error(`Invalid --adapter-config "${raw}". Use slug=json.`);
    }
    if (seenConfigSlugs.has(slug)) {
      throw new Error(`Duplicate --adapter-config for agent slug "${slug}".`);
    }
    seenConfigSlugs.add(slug);

    const override = result[slug];
    if (!override) {
      throw new Error(
        `--adapter-config for "${slug}" requires a matching --adapter-override.`,
      );
    }

    override.adapterConfig = parseJsonObject(
      rawConfig,
      slug,
      "--adapter-config",
    );
  }

  for (const [slug, override] of Object.entries(result)) {
    if (!override.adapterConfig) {
      throw new Error(
        `--adapter-override for "${slug}" requires a matching --adapter-config.`,
      );
    }
  }
  return result as Record<string, CompanyPortabilityAdapterOverride>;
}
