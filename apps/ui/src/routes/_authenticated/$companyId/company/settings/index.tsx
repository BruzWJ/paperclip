import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AccessibleDropzone } from "@/components/patterns/AccessibleDropzone";
import { BrandColorPicker } from "@/components/patterns/BrandColorPicker";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { LabeledFormField, SettingsSwitchField } from "@/components/patterns/FormPatterns";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PROJECT_COLORS } from "@paperclipai/shared";
import { Download, Settings, Upload } from "lucide-react";
import { useEffect } from "react";
import {
  MAX_COMPANY_ATTACHMENT_MAX_MIB,
  useCompanySettingsController,
} from "./-useCompanySettingsController";

export const Route = createFileRoute("/_authenticated/$companyId/company/settings/")({
  component: CompanySettings,
});

function CompanySettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const {
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
    handleLogoFile,
    handleLogoFileError,
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
  } = useCompanySettingsController();

  useEffect(() => {
    setBreadcrumbs([
      {
        label: selectedCompany?.name ?? "Company",
        renderLink: (content) => (
          <Link to="/$companyId/dashboard" params={{ companyId }}>
            {content}
          </Link>
        ),
      },
      { label: "Settings" },
    ]);
  }, [companyId, setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <Alert>
        <AlertDescription>No company selected. Select a company from the switcher above.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      {companySettingsStatus ? (
        <p className="sr-only" role="status">
          {companySettingsStatus}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground"  data-icon="inline-start"/>
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <LabeledFormField label="Company name" description="The display name for your company.">
            <Input
              aria-label="Company name"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </LabeledFormField>
          <LabeledFormField
            label="Description"
            description="Optional description shown in the company profile."
          >
            <Input
              aria-label="Company description"
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </LabeledFormField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <Avatar size="lg">
                <AvatarImage src={logoUrl || undefined} alt={`${companyName || selectedCompany.name} logo`} />
                <AvatarFallback>
                  {(companyName || selectedCompany.name).trim().charAt(0).toUpperCase() || "?"}
                </AvatarFallback>
              </Avatar>
            </div>
            <div className="flex-1 space-y-3">
              <LabeledFormField label="Logo" description="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image.">
                <div className="space-y-2">
                  <AccessibleDropzone
                    accept={{
                      "image/png": [".png"],
                      "image/jpeg": [".jpg", ".jpeg"],
                      "image/webp": [".webp"],
                      "image/gif": [".gif"],
                      "image/svg+xml": [".svg"],
                    }}
                    ariaLabel="Upload company logo"
                    disabled={logoUploadMutation.isPending}
                    maxFiles={1}
                    onDrop={(files) => {
                      const file = files[0];
                      if (file) handleLogoFile(file);
                    }}
                    onError={handleLogoFileError}
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => clearLogoMutation.mutate()}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <FieldError className="text-xs">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : "Logo upload failed")}
                    </FieldError>
                  )}
                  {clearLogoMutation.isError && (
                    <FieldError className="text-xs">{clearLogoMutation.error.message}</FieldError>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground" role="status">
                      Uploading logo...
                    </span>
                  )}
                </div>
              </LabeledFormField>
              <LabeledFormField
                label="Brand color"
                description="Sets the hue for the company icon. Leave empty for auto-generated color."
              >
                {/* token-extraction: allowlisted — the picker fallback must be a real hex color. */}
                <BrandColorPicker
                  value={brandColor}
                  fallbackValue={PROJECT_COLORS[0]}
                  onChange={setBrandColor}
                />
              </LabeledFormField>
              <LabeledFormField
                label="Attachment size limit"
                description={`Accepted range: 1-${MAX_COMPANY_ATTACHMENT_MAX_MIB} MiB.`}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Attachment size limit in MiB"
                      type="number"
                      min={1}
                      max={MAX_COMPANY_ATTACHMENT_MAX_MIB}
                      step={1}
                      value={attachmentMaxMiB}
                      onChange={(e) => setAttachmentMaxMiB(e.target.value)}
                      className="w-28"
                    />
                    <span className="text-xs text-muted-foreground">MiB</span>
                  </div>
                  {!attachmentMaxValid && (
                    <FieldError className="text-xs">
                      Enter a whole number from 1 to {MAX_COMPANY_ATTACHMENT_MAX_MIB}.
                    </FieldError>
                  )}
                </div>
              </LabeledFormField>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim() || !attachmentMaxValid}
          >
            {generalMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground" role="status">
              Saved
            </span>
          )}
          {generalMutation.isError && (
            <FieldError className="text-xs">
              {generalMutation.error instanceof Error ? generalMutation.error.message : "Failed to save"}
            </FieldError>
          )}
        </div>
      )}

      <Card data-testid="company-settings-team-section">
        <CardHeader>
          <CardTitle>Hiring</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsSwitchField
            id="company-settings-team-approval-toggle"
            label="Require board approval for new hires"
            description="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onCheckedChange={(value) => settingsMutation.mutate(value)}
            data-testid="company-settings-team-approval-toggle"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Company Packages</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Import and export have moved to dedicated pages accessible from the{" "}
            <Link to="/$companyId/org" params={{ companyId }} className="underline hover:text-foreground">
              Org Chart
            </Link>{" "}
            header.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link to="/$companyId/company/export/$" params={{ companyId, _splat: "" }}>
                <Download data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
                Export
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/$companyId/company/import" params={{ companyId }}>
                <Upload data-icon="inline-start" className="mr-1.5 h-3.5 w-3.5" />
                Import
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Danger Zone</CardTitle>
          <CardDescription>
            Archive this company to hide it from the sidebar. This persists in the database.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ConfirmActionDialog
            title={`Archive “${selectedCompany.name}”?`}
            description="Archive this company to hide it from the sidebar. This persists in the database."
            confirmLabel="Archive company"
            pendingLabel="Archiving..."
            variant="destructive"
            disabled={selectedCompany.status === "archived"}
            pending={archiveMutation.isPending}
            onConfirm={archiveCompany}
            triggerAsChild
            trigger={
              <Button
                variant="destructive"
                disabled={archiveMutation.isPending || selectedCompany.status === "archived"}
              >
                {archiveMutation.isPending
                  ? "Archiving..."
                  : selectedCompany.status === "archived"
                    ? "Already archived"
                    : "Archive company"}
              </Button>
            }
          />
          {archiveMutation.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive company"}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
