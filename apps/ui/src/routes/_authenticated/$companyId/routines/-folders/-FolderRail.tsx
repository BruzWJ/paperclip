import { Banner, BannerAction, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import type { FolderListItem, FolderListResult } from "@paperclipai/shared";
import { Folder as FolderIcon, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { FolderSwatch, type FolderSelection } from "./-folder-primitives";

export function FolderRail({
  result,
  selection,
  itemLabelPlural,
  allLabel,
  loading = false,
  onSelect,
  onCreate,
  onRename,
  onEdit,
  onDelete,
}: {
  result: FolderListResult | null | undefined;
  selection: FolderSelection;
  itemLabelPlural: string;
  allLabel: string;
  loading?: boolean;
  onSelect: (selection: FolderSelection) => void;
  onCreate: () => void;
  onRename: (folder: FolderListItem, name: string) => void;
  onEdit: (folder: FolderListItem) => void;
  onDelete: (folder: FolderListItem) => void;
}) {
  const folders = result?.folders ?? [];
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (!renamingFolderId) return;
    const folder = folders.find((entry) => entry.id === renamingFolderId);
    if (!folder) setRenamingFolderId(null);
  }, [folders, renamingFolderId]);

  function startRename(folder: FolderListItem) {
    setRenamingFolderId(folder.id);
    setRenameDraft(folder.name);
  }

  function commitRename(folder: FolderListItem) {
    const name = renameDraft.trim();
    if (name && name !== folder.name) onRename(folder, name);
    setRenamingFolderId(null);
  }

  function renderVirtualRow(key: FolderSelection, label: string, count: number, icon: ReactNode) {
    return (
      <SidebarMenuItem key={key}>
        <SidebarMenuButton
          type="button"
          isActive={selection === key}
          aria-current={selection === key ? "page" : undefined}
          onClick={() => onSelect(key)}
        >
          {icon}
          <span>{label}</span>
        </SidebarMenuButton>
        <SidebarMenuBadge>{count}</SidebarMenuBadge>
      </SidebarMenuItem>
    );
  }

  return (
    <Sidebar
      collapsible="none"
      role="navigation"
      aria-label={`${itemLabelPlural} folders`}
      className="hidden w-(--sz-folder-rail) shrink-0 border-r border-sidebar-border bg-sidebar md:flex"
    >
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Folders</SidebarGroupLabel>
          <SidebarGroupAction type="button" title="New folder" aria-label="New folder" onClick={onCreate}>
            <Plus  data-icon="inline-start"/>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {loading ? (
                <>
                  {[0, 1, 2].map((index) => (
                    <SidebarMenuItem key={index}>
                      <SidebarMenuSkeleton showIcon />
                    </SidebarMenuItem>
                  ))}
                </>
              ) : (
                <>
                  {renderVirtualRow("all", allLabel, result?.allCount ?? 0, <FolderIcon  data-icon="inline-start"/>)}
                  {folders.map((folder) => (
                    <FolderRailItem
                      key={folder.id}
                      folder={folder}
                      active={selection === folder.id}
                      renaming={renamingFolderId === folder.id}
                      renameDraft={renameDraft}
                      onRenameDraftChange={setRenameDraft}
                      onRenameCommit={() => commitRename(folder)}
                      onRenameCancel={() => setRenamingFolderId(null)}
                      onSelect={() => onSelect(folder.id)}
                      onStartRename={() => startRename(folder)}
                      onEdit={() => onEdit(folder)}
                      onDelete={() => onDelete(folder)}
                    />
                  ))}
                </>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {!loading ? (
          <SidebarGroup>
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {renderVirtualRow(
                  "unfiled",
                  "Unfiled",
                  result?.unfiledCount ?? 0,
                  <FolderSwatch color={null} />,
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
      </SidebarContent>
    </Sidebar>
  );
}

/** One selectable folder row composed from the shared sidebar menu primitives. */
export function FolderRailItem({
  folder,
  active,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onSelect,
  onStartRename,
  onEdit,
  onDelete,
}: {
  folder: FolderListItem;
  active: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <SidebarMenuItem>
      {renaming ? (
        <SidebarMenuButton asChild isActive={active}>
          <div>
            <FolderSwatch color={folder.color} />
            <Input
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              aria-label={`Rename ${folder.name}`}
              onKeyDown={(event) => {
                if (event.key === "Enter") onRenameCommit();
                if (event.key === "Escape") onRenameCancel();
              }}
              onBlur={onRenameCommit}
              className="h-6 min-w-0 flex-1 px-1"
              autoFocus
            />
          </div>
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton
          type="button"
          isActive={active}
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
          onDoubleClick={onStartRename}
        >
          <FolderSwatch color={folder.color} />
          <span>{folder.name}</span>
        </SidebarMenuButton>
      )}
      <SidebarMenuBadge>{folder.itemCount}</SidebarMenuBadge>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`Folder actions for ${folder.name}`}>
            <MoreHorizontal  data-icon="inline-start"/>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onStartRename}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={onEdit}>Edit color</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2  data-icon="inline-start"/>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

/**
 * Dismissible nudge shown when items exist but no folders do (ux-spec §6.3).
 * Dismissal persists per storage key.
 */
export function AllUnfiledBanner({
  storageKey,
  itemLabelPlural,
  onCreateFolder,
}: {
  storageKey: string;
  itemLabelPlural: string;
  onCreateFolder: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(storageKey, "1");
    } catch {
      // Ignore storage failures; the banner just reappears next visit.
    }
  }

  return (
    <Banner className="mb-3" visible inset onClose={dismiss}>
      <BannerIcon icon={FolderIcon} />
      <BannerTitle>Group these {itemLabelPlural} into folders to keep things tidy.</BannerTitle>
      <BannerAction onClick={onCreateFolder}>Create your first folder</BannerAction>
      <BannerClose aria-label="Dismiss folder suggestion" />
    </Banner>
  );
}
