import { assetsApi } from "@/api/assets";
import { companiesApi } from "@/api/companies";
import { useCompany } from "@/context/CompanyContext";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { queryKeys } from "@/lib/queryKeys";
import { DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES, MAX_COMPANY_ATTACHMENT_MAX_BYTES } from "@paperclipai/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ChangeEvent } from "react";

const BYTES_PER_MIB = 1024 * 1024;

export const MAX_COMPANY_ATTACHMENT_MAX_MIB = MAX_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;

export function useCompanySettingsController() {
  const companyId = useCompanyRouteId();
  const { companies, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [attachmentMaxMiB, setAttachmentMaxMiB] = useState(
    String(DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB),
  );
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setAttachmentMaxMiB(
      String(
        Math.round(
          (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) / BYTES_PER_MIB,
        ),
      ),
    );
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const attachmentMaxBytes = Number.parseInt(attachmentMaxMiB, 10) * BYTES_PER_MIB;
  const attachmentMaxValid =
    Number.isInteger(attachmentMaxBytes) &&
    attachmentMaxBytes >= BYTES_PER_MIB &&
    attachmentMaxBytes <= MAX_COMPANY_ATTACHMENT_MAX_BYTES;
  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      attachmentMaxBytes !== (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES));

  const invalidateCompanies = () => queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      attachmentMaxBytes: number;
    }) => companiesApi.update(companyId, data),
    onSuccess: invalidateCompanies,
  });
  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(companyId, {
        requireBoardApprovalForNewAgents: requireApproval,
      }),
    onSuccess: invalidateCompanies,
  });
  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void invalidateCompanies();
  };
  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(companyId, file)
        .then((asset) => companiesApi.update(companyId, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    },
  });
  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(companyId, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    },
  });
  const archiveMutation = useMutation({
    mutationFn: (nextCompanyId: string | null) => companiesApi.archive(companyId).then(() => nextCompanyId),
    onSuccess: async (nextCompanyId) => {
      await invalidateCompanies();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats,
      });
      if (nextCompanyId) {
        void navigate({
          to: "/$companyId/dashboard",
          params: { companyId: nextCompanyId },
          replace: true,
        });
      } else {
        void navigate({ to: "/onboarding", replace: true });
      }
    },
  });

  const handleLogoFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  };
  const handleSaveGeneral = () =>
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
      attachmentMaxBytes,
    });
  const archiveCompany = () =>
    archiveMutation.mutate(
      companies.find((company) => company.id !== companyId && company.status !== "archived")?.id ?? null,
    );
  const companySettingsStatus = generalMutation.isPending
    ? "Saving company settings…"
    : logoUploadMutation.isPending
      ? "Uploading company logo…"
      : clearLogoMutation.isPending
        ? "Removing company logo…"
        : settingsMutation.isPending
          ? "Saving hiring settings…"
          : archiveMutation.isPending
            ? "Archiving company…"
            : null;

  return {
    archiveCompany,
    archiveMutation,
    attachmentMaxMiB,
    attachmentMaxValid,
    brandColor,
    clearLogoMutation,
    companyId,
    companyName,
    companySettingsStatus,
    description,
    generalDirty,
    generalMutation,
    handleLogoFileChange,
    handleSaveGeneral,
    logoUploadError,
    logoUploadMutation,
    logoUrl,
    selectedCompany,
    setAttachmentMaxMiB,
    setBrandColor,
    setCompanyName,
    setDescription,
    settingsMutation,
  };
}
