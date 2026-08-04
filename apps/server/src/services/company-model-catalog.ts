import type {
  AdapterModel,
} from "@paperclipai/adapter-utils";

/**
 * Company-facing model selection has one policy owner.  Today the policy is
 * deliberately simple: every registered selectable catalog model is available
 * to every company scope. Keeping the company boundary here means future
 * company policy can tighten selection without teaching each consumer a
 * different interpretation of the global adapter registry.
 */
export interface CompanyModelCatalog {
  listModels(input: {
    companyId: string;
    adapterType: string;
  }): Promise<AdapterModel[]>;
  resolve(input: {
    companyId: string;
    modelId: string;
  }): Promise<AdapterModel>;
}

export interface CompanyModelCatalogRegistry {
  listAdapterModels(adapterType: string): Promise<AdapterModel[]>;
  resolveAvailableAdapterModel(modelId: string): Promise<AdapterModel>;
}

export class CompanyModelCatalogUnavailable extends Error {
  readonly code = "company_model_catalog_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "CompanyModelCatalogUnavailable";
  }
}

export function createCompanyModelCatalog(
  options: { registry?: CompanyModelCatalogRegistry } = {},
): CompanyModelCatalog {
  const registry = options.registry ?? {
    async listAdapterModels(adapterType: string) {
      const { listAdapterModels } = await import("../adapters/registry.js");
      return listAdapterModels(adapterType);
    },
    async resolveAvailableAdapterModel(modelId: string) {
      const { resolveAvailableAdapterModel } = await import(
        "../adapters/registry.js"
      );
      return resolveAvailableAdapterModel(modelId);
    },
  };

  function assertCompanyScope(companyId: string): void {
    if (!companyId || companyId !== companyId.trim()) {
      throw new CompanyModelCatalogUnavailable(
        "Company model catalog requires an exact company identity",
      );
    }
  }

  return {
    async listModels(input) {
      assertCompanyScope(input.companyId);
      return registry.listAdapterModels(input.adapterType);
    },
    async resolve(input) {
      assertCompanyScope(input.companyId);
      return registry.resolveAvailableAdapterModel(input.modelId);
    },
  };
}
