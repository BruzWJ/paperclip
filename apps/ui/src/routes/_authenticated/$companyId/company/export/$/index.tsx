import { CompanyExportScreen } from "@/routes/_authenticated/$companyId/company/export/$/-CompanyExportScreen";
import { isPortableRelativePath } from "@paperclipai/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";

export { CompanyExportScreen as CompanyExport } from "@/routes/_authenticated/$companyId/company/export/$/-CompanyExportScreen";

export function parseCompanyExportFilePath(splat: string | undefined): string | null {
  if (splat === undefined || splat.length === 0) return null;
  if (!splat.startsWith("files/") || splat === "files/") throw notFound();
  const filePath = splat.slice("files/".length);
  if (!isPortableRelativePath(filePath)) throw notFound();
  return filePath;
}

export const Route = createFileRoute("/_authenticated/$companyId/company/export/$/")({
  loader: ({ params }) => ({
    filePath: parseCompanyExportFilePath(params._splat),
  }),
  component: CompanyExportRoute,
});

function CompanyExportRoute() {
  const { filePath } = Route.useLoaderData();
  return <CompanyExportScreen filePath={filePath} />;
}
