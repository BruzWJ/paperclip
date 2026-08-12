import { createFileRoute, Navigate } from "@tanstack/react-router";
import {
  ROOT_REDIRECT_COMPANY_STORAGE_KEY,
  resolveRootRedirectCompanyId,
  useCompany,
} from "@/context/CompanyContext";
import { RouteLoadingFallback } from "../-route-ui";

function CompanyRootRedirect() {
  const { companies, loading } = useCompany();

  if (loading) return <RouteLoadingFallback />;

  const sidebarCompanies = companies.filter(
    (company) => company.status !== "archived",
  );
  const targetCompanyId = resolveRootRedirectCompanyId({
    companies,
    sidebarCompanies,
    storedCompanyId: localStorage.getItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY),
  });
  if (!targetCompanyId) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <Navigate
      to="/$companyId/dashboard"
      params={{ companyId: targetCompanyId }}
      replace
    />
  );
}

export const Route = createFileRoute("/_authenticated/")({
  component: CompanyRootRedirect,
});
