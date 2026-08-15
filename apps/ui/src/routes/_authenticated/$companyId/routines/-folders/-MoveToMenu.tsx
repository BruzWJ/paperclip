import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { FolderListItem } from "@paperclipai/shared";
import { Check, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { FolderSwatch } from "./-folder-primitives";

interface MoveToMenuProps {
  folders: FolderListItem[];
  currentFolderId: string | null | undefined;
  onMove: (folderId: string | null) => void;
  onCreateAndMove: () => void;
}

export function BulkBar({
  selectedCount,
  folders,
  onMove,
  onCreateAndMove,
  onClear,
  onDone,
}: {
  selectedCount: number;
  folders: FolderListItem[];
  onMove: (folderId: string | null) => void;
  onCreateAndMove: () => void;
  onClear: () => void;
  onDone: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <Card className="sticky top-2 z-10 flex-row flex-wrap items-center gap-2 p-2">
      <span className="mr-auto text-sm text-muted-foreground">{selectedCount} selected</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            Move to...
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <MoveToMenuItems
            folders={folders}
            currentFolderId={undefined}
            onMove={onMove}
            onCreateAndMove={onCreateAndMove}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Deselect all
      </Button>
      <Button size="sm" onClick={onDone}>
        Done
      </Button>
    </Card>
  );
}

export function MoveToMenu({ folders, currentFolderId, onMove, onCreateAndMove }: MoveToMenuProps) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Move to...</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <MoveToMenuItems
          folders={folders}
          currentFolderId={currentFolderId}
          onMove={onMove}
          onCreateAndMove={onCreateAndMove}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function MoveToMenuItems({ folders, currentFolderId, onMove, onCreateAndMove }: MoveToMenuProps) {
  const [query, setQuery] = useState("");
  const visibleFolders = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    if (!lowered) return folders;
    return folders.filter((folder) => folder.name.toLowerCase().includes(lowered));
  }, [folders, query]);

  return (
    <>
      <InputGroup className="h-8">
        <InputGroupAddon>
          <Search  data-icon="inline-start"/>
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search folders"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder="Search folders"
        />
      </InputGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => onMove(null)}>
        <FolderSwatch color={null} />
        Unfiled
        {currentFolderId == null ? <Check className="ml-auto h-3.5 w-3.5"  data-icon="inline-start"/> : null}
      </DropdownMenuItem>
      {visibleFolders.map((folder) => (
        <DropdownMenuItem key={folder.id} onSelect={() => onMove(folder.id)}>
          <FolderSwatch color={folder.color} />
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {currentFolderId === folder.id ? <Check className="ml-auto h-3.5 w-3.5"  data-icon="inline-start"/> : null}
        </DropdownMenuItem>
      ))}
      {visibleFolders.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">No folders match.</div>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onCreateAndMove}>
        <Plus className="h-3.5 w-3.5"  data-icon="inline-start"/>
        New folder...
      </DropdownMenuItem>
    </>
  );
}
