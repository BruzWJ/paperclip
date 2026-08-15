import type { SecretPathBreadcrumb, SecretPathFolder } from "@/routes/_authenticated/$companyId/company/settings/secrets/-secret-path";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Ban,
  CheckCircle2,
  ChevronRight,
  CornerLeftUp,
  Folder,
  KeyRound,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { UnifiedSecretRow, formatSecretPathCounts } from "./-secrets-model";
import { useSecretsPage } from "./-SecretsPageContext";

export function SecretsRowActions({ row }: { row: UnifiedSecretRow }) {
  const {
    definitionStatusMutation,
    myUserSecrets,
    openEditDefinition,
    openRotateSecret,
    openSecretRow,
    setDefinitionDeleteConfirm,
    setDeleteConfirm,
    setSetMyValueFor,
    setUsageDialogSecretId,
    statusMutation,
  } = useSecretsPage();
  const name = row.kind === "company" ? row.secret.name : row.definition.name;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
          <MoreHorizontal className="h-4 w-4"  data-icon="inline-start"/>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => openSecretRow(row)}>
          <KeyRound className="h-4 w-4"  data-icon="inline-end"/> View details
        </DropdownMenuItem>
        {row.kind === "company" ? (
          <>
            <DropdownMenuItem onSelect={() => setUsageDialogSecretId(row.secret.id)}>
              <Link2 className="h-4 w-4"  data-icon="inline-end"/> View references ({row.secret.referenceCount ?? 0})
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openRotateSecret(row.secret)}>
              <RefreshCw className="h-4 w-4"  data-icon="inline-end"/>
              {row.secret.managedMode === "external_reference" ? "Update reference" : "Update value"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={statusMutation.isPending}
              onSelect={() =>
                statusMutation.mutate({
                  id: row.secret.id,
                  status: row.secret.status === "active" ? "disabled" : "active",
                })
              }
            >
              {row.secret.status === "active" ? (
                <Ban className="h-4 w-4"  data-icon="inline-start"/>
              ) : (
                <CheckCircle2 className="h-4 w-4"  data-icon="inline-start"/>
              )}
              {row.secret.status === "active" ? "Disable" : "Activate"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={statusMutation.isPending}
              onSelect={() =>
                statusMutation.mutate({
                  id: row.secret.id,
                  status: row.secret.status === "archived" ? "active" : "archived",
                })
              }
            >
              {row.secret.status === "archived" ? (
                <ArchiveRestore className="h-4 w-4"  data-icon="inline-start"/>
              ) : (
                <Archive className="h-4 w-4"  data-icon="inline-start"/>
              )}
              {row.secret.status === "archived" ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteConfirm(row.secret)}>
              <Trash2 className="h-4 w-4"  data-icon="inline-end"/> Delete secret
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem
              disabled={row.definition.status !== "active"}
              onSelect={() =>
                setSetMyValueFor(
                  myUserSecrets.find((entry) => entry.definition.id === row.definition.id) ?? {
                    definition: row.definition,
                    secret: null,
                  },
                )
              }
            >
              <KeyRound className="h-4 w-4"  data-icon="inline-start"/>
              {myUserSecrets.find((entry) => entry.definition.id === row.definition.id)?.secret
                ? "Update my value"
                : "Set my value"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openEditDefinition(row.definition)}>
              <Pencil className="h-4 w-4"  data-icon="inline-end"/> Edit definition
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={definitionStatusMutation.isPending}
              onSelect={() =>
                definitionStatusMutation.mutate({
                  definition: row.definition,
                  status: row.definition.status === "active" ? "disabled" : "active",
                })
              }
            >
              {row.definition.status === "active" ? (
                <Ban className="h-4 w-4"  data-icon="inline-start"/>
              ) : (
                <CheckCircle2 className="h-4 w-4"  data-icon="inline-start"/>
              )}
              {row.definition.status === "active" ? "Disable" : "Activate"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={definitionStatusMutation.isPending}
              onSelect={() =>
                definitionStatusMutation.mutate({
                  definition: row.definition,
                  status: row.definition.status === "archived" ? "active" : "archived",
                })
              }
            >
              {row.definition.status === "archived" ? (
                <ArchiveRestore className="h-4 w-4"  data-icon="inline-start"/>
              ) : (
                <Archive className="h-4 w-4"  data-icon="inline-start"/>
              )}
              {row.definition.status === "archived" ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDefinitionDeleteConfirm(row.definition)}
            >
              <Trash2 className="h-4 w-4"  data-icon="inline-end"/> Delete definition
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SecretsFolderItem({ folder }: { folder: SecretPathFolder }) {
  const { folderSearch } = useSecretsPage();
  return (
    <Item asChild variant="outline">
      <Link to="." search={folderSearch(folder.path)} activeOptions={{ exact: true, includeSearch: true }}>
        <ItemMedia variant="icon">
          <Folder  data-icon="inline-start"/>
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{folder.name}</ItemTitle>
          <ItemDescription>{formatSecretPathCounts(folder.secretCount, folder.folderCount)}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <ChevronRight  data-icon="inline-start"/>
        </ItemActions>
      </Link>
    </Item>
  );
}

export function SecretsUpItem() {
  const { folderSearch, parentFolderPath } = useSecretsPage();
  const parentLabel = parentFolderPath ? parentFolderPath.split("/").pop()! : "All secrets";
  const target = (
    <Link to="." search={folderSearch(parentFolderPath)} activeOptions={{ exact: true, includeSearch: true }}>
      <CornerLeftUp  data-icon="inline-start"/> Up to {parentLabel}
    </Link>
  );
  return (
    <Item asChild variant="outline">
      {target}
    </Item>
  );
}

export function SecretsBreadcrumb() {
  const { breadcrumbs, folderSearch } = useSecretsPage();
  const fullTrail: SecretPathBreadcrumb[] = [{ name: "All secrets", path: "" }, ...breadcrumbs];
  // Middle-truncate deep paths: root · … · last two.
  const collapsed =
    fullTrail.length > 4 ? [fullTrail[0], { name: "…", path: "" }, ...fullTrail.slice(-2)] : fullTrail;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {collapsed.map((crumb, index) => {
          const isLast = index === collapsed.length - 1;
          const isEllipsis = crumb.name === "…" && crumb.path === "" && index > 0 && !isLast;
          return (
            <BreadcrumbItem key={`${crumb.path}:${index}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              {isEllipsis ? (
                <BreadcrumbEllipsis />
              ) : isLast ? (
                <BreadcrumbPage>{crumb.name}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link
                    to="."
                    search={folderSearch(crumb.path)}
                    activeOptions={{ exact: true, includeSearch: true }}
                  >
                    {crumb.name}
                  </Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
