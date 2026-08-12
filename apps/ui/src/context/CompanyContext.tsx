import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { useOptionalCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { companiesListQueryOptions, type CompanyListResult } from "../api/companies-query";

interface CompanyContextValue {
  companies: Company[];
  selectedCompany: Company | null;
  loading: boolean;
  error: Error | null;
}

export const ROOT_REDIRECT_COMPANY_STORAGE_KEY = "paperclip.rootRedirectCompanyId";

const CompanyContext = createContext<CompanyContextValue | null>(null);

export function resolveRootRedirectCompanyId(input: {
  companies: Array<Pick<Company, "id">>;
  sidebarCompanies: Array<Pick<Company, "id">>;
  storedCompanyId: string | null;
}) {
  if (input.companies.length === 0) return null;

  const selectableCompanies = input.sidebarCompanies.length > 0
    ? input.sidebarCompanies
    : input.companies;
  if (input.storedCompanyId && selectableCompanies.some((company) => company.id === input.storedCompanyId)) {
    return input.storedCompanyId;
  }
  return selectableCompanies[0]?.id ?? null;
}

export function shouldClearRootRedirectCompanyId(input: {
  companies: Array<Pick<Company, "id">>;
  isLoading: boolean;
  unauthorized: boolean;
}) {
  return !input.isLoading && !input.unauthorized && input.companies.length === 0;
}

export function rememberRootRedirectCompanyId(companyId: string) {
  localStorage.setItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY, companyId);
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const companyId = useOptionalCompanyRouteId();

  const { data: companiesResult = { companies: [], unauthorized: false }, isLoading, error } =
    useQuery<CompanyListResult>(companiesListQueryOptions);
  const companies = companiesResult.companies;
  const companyListUnauthorized = companiesResult.unauthorized;

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === companyId) ?? null,
    [companies, companyId],
  );

  // The URL is the active company authority. Persistence only remembers the
  // target for a later visit to the authenticated root route.
  useEffect(() => {
    if (isLoading) return;
    if (companies.length === 0) {
      if (shouldClearRootRedirectCompanyId({ companies, isLoading: false, unauthorized: companyListUnauthorized })) {
        localStorage.removeItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY);
      }
      return;
    }
    if (selectedCompany) {
      rememberRootRedirectCompanyId(selectedCompany.id);
    }
  }, [companies, companyListUnauthorized, isLoading, selectedCompany]);

  const value = useMemo(
    () => ({
      companies,
      selectedCompany,
      loading: isLoading,
      error: error as Error | null,
    }),
    [
      companies,
      selectedCompany,
      isLoading,
      error,
    ],
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) {
    throw new Error("useCompany must be used within CompanyProvider");
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link useCompany}. Returns null when called outside a
 * CompanyProvider instead of throwing, so components that may render in
 * provider-less surfaces (e.g. exported/standalone markdown) can read company
 * state without crashing.
 */
export function useOptionalCompany(): CompanyContextValue | null {
  return useContext(CompanyContext);
}
