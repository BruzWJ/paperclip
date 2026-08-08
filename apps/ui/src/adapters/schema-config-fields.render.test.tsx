// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConfigSchema, CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  SchemaConfigFields,
  useAdapterConfigSchema,
} from "./schema-config-fields";
import { queryKeys } from "@/lib/queryKeys";

function renderIntoContainer(
  children: React.ReactNode,
  seed?: (queryClient: QueryClient) => void,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    );
  });
  return { container, root, queryClient };
}

function EmptySchemaProbe() {
  const { schema, error, isLoading } = useAdapterConfigSchema("fixture");
  if (isLoading) return <span>loading</span>;
  if (error) return <span>{error}</span>;
  return <span>{schema ? `fields:${schema.fields.length}` : "missing"}</span>;
}

describe("SchemaConfigFields dynamic schemas", () => {
  let roots: Root[] = [];
  let queryClients: QueryClient[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) flushSync(() => root.unmount());
    for (const queryClient of queryClients) queryClient.clear();
    roots = [];
    queryClients = [];
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("accepts an empty server schema as a successful no-configuration result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ fields: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rendered = renderIntoContainer(<EmptySchemaProbe />);
    roots.push(rendered.root);
    queryClients.push(rendered.queryClient);

    await vi.waitFor(() => {
      expect(rendered.container.textContent).toBe("fields:0");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the ready catalog schema without a per-adapter request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const schema: AdapterConfigSchema = {
      fields: [{
        key: "model",
        label: "Model",
        type: "select",
        options: [{ label: "Fast", value: "fast" }],
      }],
    };
    const rendered = renderIntoContainer(
      <EmptySchemaProbe />,
      (queryClient) => {
        queryClient.setQueryData(queryKeys.adapters.all, [{
          type: "fixture",
          label: "Fixture",
          source: "acpx",
          modelsCount: 1,
          loaded: true,
          drivers: ["local"],
          registryName: "fixture",
          configSchema: schema,
          capabilities: {
            contractVersion: "acpx-runtime/v1",
            runtimeControls: [],
            supportsModelProfiles: false,
          },
        }]);
      },
    );
    roots.push(rendered.root);
    queryClients.push(rendered.queryClient);

    await vi.waitFor(() => {
      expect(rendered.container.textContent).toBe("fields:1");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not choose the first server option when no explicit default exists", async () => {
    const schema: AdapterConfigSchema = {
      fields: [{
        key: "model",
        label: "Model",
        type: "select",
        required: true,
        options: [
          { label: "Alpha", value: "alpha" },
          { label: "Beta", value: "beta" },
        ],
      }],
    };
    const set = vi.fn();
    const values: CreateConfigValues = {
      adapterType: "fixture",
    };
    const rendered = renderIntoContainer(
      <SchemaConfigFields
        mode="create"
        isCreate
        adapterType="fixture"
        values={values}
        set={set}
        config={{}}
        eff={(_group, _field, original) => original}
        mark={() => undefined}
        resolvedSchema={schema}
      />,
    );
    roots.push(rendered.root);
    queryClients.push(rendered.queryClient);

    await vi.waitFor(() => {
      expect(rendered.container.textContent).toContain("Select...");
    });
    expect(set).not.toHaveBeenCalled();
  });
});
