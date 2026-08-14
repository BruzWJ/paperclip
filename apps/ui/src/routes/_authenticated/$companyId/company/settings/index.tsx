import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { createFileRoute, Link } from "@tanstack/react-router";
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
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field>
            <FieldLabel>Company name</FieldLabel>
            <FieldDescription>The display name for your company.</FieldDescription>
            <Input
              aria-label="Company name"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Description</FieldLabel>
            <FieldDescription>Optional description shown in the company profile.</FieldDescription>
            <Input
              aria-label="Company description"
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
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
              <Field>
                <FieldLabel>Logo</FieldLabel>
                <FieldDescription>Upload a PNG, JPEG, WEBP, GIF, or SVG logo image.</FieldDescription>
                <div className="space-y-2">
                  <Input
                    aria-label="Company logo image"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="h-auto py-1.5 file:mr-4 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
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
              </Field>
              <Field>
                <FieldLabel>Brand color</FieldLabel>
                <FieldDescription>
                  Sets the hue for the company icon. Leave empty for auto-generated color.
                </FieldDescription>
                <div className="flex items-center gap-2">
                  {/* token-extraction: allowlisted — a color input value must be a real hex string, not a var() reference. */}
                  <Input
                    aria-label="Brand color picker"
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <Input
                    aria-label="Brand color hex value"
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder="Auto"
                    className="w-28 font-mono"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
              <Field>
                <FieldLabel>Attachment size limit</FieldLabel>
                <FieldDescription>Accepted range: 1-{MAX_COMPANY_ATTACHMENT_MAX_MIB} MiB.</FieldDescription>
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
              </Field>
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
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="company-settings-team-approval-toggle">
                Require board approval for new hires
              </FieldLabel>
              <FieldDescription>New agent hires stay pending until approved by board.</FieldDescription>
            </FieldContent>
            <Switch
              id="company-settings-team-approval-toggle"
              checked={!!selectedCompany.requireBoardApprovalForNewAgents}
              onCheckedChange={(value) => settingsMutation.mutate(value)}
              data-testid="company-settings-team-approval-toggle"
            />
          </Field>
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
          <AlertDialog>
            <AlertDialogTrigger asChild>
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
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive “{selectedCompany.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  Archive this company to hide it from the sidebar. This persists in the database.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={archiveCompany}>
                  Archive company
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
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
