// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeMoneyAmount, type Company } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { TestRouter } from "../test/TestRouter";
import {
  CompanyProvider,
  ROOT_REDIRECT_COMPANY_STORAGE_KEY,
  resolveRootRedirectCompanyId,
  shouldClearRootRedirectCompanyId,
  useCompany,
} from "./CompanyContext";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

function makeCompany(id: string): Company {
  return {
    id,
    name: id === COMPANY_ID ? "Paperclip" : "Other",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    taskPrefix: "PAP",
    taskCounter: 1,
    budgetCurrency: "USD",
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function Probe({ onCompanyId }: { onCompanyId: (companyId: string | null) => void }) {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;
  useEffect(() => {
    onCompanyId(companyId);
  }, [companyId, onCompanyId]);
  return <div data-company-id={companyId ?? ""} />;
}

describe("resolveRootRedirectCompanyId", () => {
  it("returns null when no company can be targeted", () => {
    expect(resolveRootRedirectCompanyId({
      companies: [],
      sidebarCompanies: [],
      storedCompanyId: COMPANY_ID,
    })).toBeNull();
  });

  it("uses an exact stored target and rejects a stale one", () => {
    const companies = [{ id: COMPANY_ID }, { id: OTHER_COMPANY_ID }];
    expect(resolveRootRedirectCompanyId({
      companies,
      sidebarCompanies: companies,
      storedCompanyId: OTHER_COMPANY_ID,
    })).toBe(OTHER_COMPANY_ID);
    expect(resolveRootRedirectCompanyId({
      companies,
      sidebarCompanies: companies,
      storedCompanyId: "stale-company",
    })).toBe(COMPANY_ID);
  });

  it("does not select an archived stored target when an active company exists", () => {
    expect(resolveRootRedirectCompanyId({
      companies: [{ id: OTHER_COMPANY_ID }, { id: COMPANY_ID }],
      sidebarCompanies: [{ id: COMPANY_ID }],
      storedCompanyId: OTHER_COMPANY_ID,
    })).toBe(COMPANY_ID);
  });
});

describe("shouldClearRootRedirectCompanyId", () => {
  it("preserves the redirect target for an unauthorized company-list response", () => {
    expect(shouldClearRootRedirectCompanyId({
      companies: [],
      isLoading: false,
      unauthorized: true,
    })).toBe(false);
  });

  it("clears the redirect target for an authorized empty company list", () => {
    expect(shouldClearRootRedirectCompanyId({
      companies: [],
      isLoading: false,
      unauthorized: false,
    })).toBe(true);
  });
});

describe("CompanyProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [makeCompany(COMPANY_ID), makeCompany(OTHER_COMPANY_ID)],
      unauthorized: false,
    });
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("exposes the route company synchronously and remembers it only for root redirects", async () => {
    localStorage.setItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY, OTHER_COMPANY_ID);
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <TestRouter initialEntries={[`/${COMPANY_ID}/dashboard`]} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <CompanyProvider>
              <Probe onCompanyId={(companyId) => seen.push(companyId)} />
            </CompanyProvider>
          </QueryClientProvider>
        </TestRouter>,
      );
    });

    expect(seen).toEqual([COMPANY_ID]);
    expect(localStorage.getItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY)).toBe(COMPANY_ID);
  });

  it("does not turn a stored redirect target into active company state on a global route", async () => {
    localStorage.setItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY, OTHER_COMPANY_ID);
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <TestRouter initialEntries={["/auth"]} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <CompanyProvider>
              <Probe onCompanyId={(companyId) => seen.push(companyId)} />
            </CompanyProvider>
          </QueryClientProvider>
        </TestRouter>,
      );
    });

    expect(seen).toEqual([null]);
    expect(localStorage.getItem(ROOT_REDIRECT_COMPANY_STORAGE_KEY)).toBe(OTHER_COMPANY_ID);
  });
});
