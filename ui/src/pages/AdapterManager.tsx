import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adaptersApi, type AdapterInfo } from "@/api/adapters";
import { useAdapterCatalogSync } from "@/adapters/use-adapter-catalog";
import { queryKeys } from "@/lib/queryKeys";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function AdapterCatalogRow({ adapter }: { adapter: AdapterInfo }) {
  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{adapter.label}</span>
            <Badge variant="outline">ACP wire v1</Badge>
            <Badge
              variant="secondary"
              className={adapter.loaded ? "text-green-700" : "text-destructive"}
            >
              {adapter.loaded ? "Ready" : "Unavailable"}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Exact adapter name <code>{adapter.type}</code> · {adapter.modelsCount} models
          </p>
        </div>
        <code className="rounded bg-muted px-2 py-1 text-xs">
          {adapter.registryName}
        </code>
      </div>

      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Pinned frontend</dt>
          <dd className="break-all font-mono">
            {adapter.frontendPackage}@{adapter.frontendVersion}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Frontend digest</dt>
          <dd className="break-all font-mono" title={adapter.frontendDigest}>
            {adapter.frontendDigest}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-1.5">
        {adapter.capabilities.resume && <Badge variant="secondary">Resume</Badge>}
        {adapter.capabilities.cancel && <Badge variant="secondary">Cancel</Badge>}
        {adapter.capabilities.sessionConfig && (
          <Badge variant="secondary">Session config</Badge>
        )}
        {adapter.capabilities.sessionScopedMcpReplacement && (
          <Badge variant="secondary">Request-scoped MCP</Badge>
        )}
      </div>
    </li>
  );
}

export function AdapterManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  useAdapterCatalogSync();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "ACP adapters" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: adapters, isLoading, error } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading ACP catalog...</div>;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Cpu className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">ACP adapters</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          This immutable catalog is admitted by the server. Each entry resolves
          to a pinned, conformance-approved ACP frontend and uses the CLI&apos;s
          native authentication.
        </p>
      </div>

      {error ? (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {error instanceof Error ? error.message : "The ACP catalog is unavailable."}
          </CardContent>
        </Card>
      ) : !adapters?.length ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No ACP adapter is admitted by this server.
          </CardContent>
        </Card>
      ) : (
        <Card className="block py-0">
          <ul className="divide-y">{adapters.map((adapter) => (
            <AdapterCatalogRow key={adapter.type} adapter={adapter} />
          ))}</ul>
        </Card>
      )}
    </div>
  );
}
