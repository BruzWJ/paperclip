import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item";
import { FileText, Paperclip, X } from "lucide-react";
import { formatFileSize } from "./model";
import { useNewTaskDialogViewModel } from "./context";

export function NewTaskStagedFiles() {
  const { values, derived, creation, actions } = useNewTaskDialogViewModel();
  if (!values.stagedFiles.length) return null;
  return (
    <Card className="mt-4 gap-3 py-3 shadow-none">
      {derived.stagedDocuments.length ? (
        <>
          <CardHeader className="px-3">
            <CardTitle className="text-xs">Documents</CardTitle>
          </CardHeader>
          <CardContent className="px-3">
            <ItemGroup className="gap-2">
              {derived.stagedDocuments.map((item) => (
                <Item key={item.id} variant="outline" size="sm">
                  <ItemContent className="min-w-0">
                    <ItemTitle>
                      <Badge
                        variant="outline"
                        className="border-border font-mono text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground"
                      >
                        {item.documentKey}
                      </Badge>
                      <span className="truncate text-sm">{item.file.name}</span>
                    </ItemTitle>
                    <ItemDescription className="flex items-center gap-2 text-(length:--text-micro)">
                      <FileText className="h-3.5 w-3.5" />
                      <span>{item.title || item.file.name}</span>
                      <span>•</span>
                      <span>{formatFileSize(item.file)}</span>
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => actions.removeStagedFile(item.id)}
                      disabled={creation.createTask.isPending}
                      title="Remove document"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </>
      ) : null}
      {derived.stagedAttachments.length ? (
        <>
          <CardHeader className="px-3">
            <CardTitle className="text-xs">Attachments</CardTitle>
          </CardHeader>
          <CardContent className="px-3">
            <ItemGroup className="gap-2">
              {derived.stagedAttachments.map((item) => (
                <Item key={item.id} variant="outline" size="sm">
                  <ItemContent className="min-w-0">
                    <ItemTitle>
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm">{item.file.name}</span>
                    </ItemTitle>
                    <ItemDescription className="text-(length:--text-micro)">
                      {item.file.type || "application/octet-stream"} • {formatFileSize(item.file)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => actions.removeStagedFile(item.id)}
                      disabled={creation.createTask.isPending}
                      title="Remove attachment"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </>
      ) : null}
    </Card>
  );
}
