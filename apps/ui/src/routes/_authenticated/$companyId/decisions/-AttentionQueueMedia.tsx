import type { AttentionDetailImage, AttentionItem, CompanyBoardRouteTarget } from "@paperclipai/shared";
import { ExternalLink } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { attentionImageUrl } from "@/lib/attention";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { CompanyBoardLink } from "../../../../features/navigation/CompanyBoardLink";
import { getProjectIcon } from "@/lib/project-icons";

/** Inline project identity keeps useful context without a competing badge. */
export function ProjectMeta({ project }: { project: NonNullable<AttentionItem["project"]> }) {
  const ProjectIcon = getProjectIcon(project.icon);
  return (
    <span
      className="inline-flex max-w-(--sz-12rem) items-center gap-1.5 text-(length:--text-nano) text-muted-foreground"
      title={project.name}
      data-testid="attention-project-meta"
    >
      <Avatar size="sm" style={{ backgroundColor: project.color ?? undefined }} aria-hidden="true">
        <AvatarFallback className={project.color ? "bg-transparent" : undefined}>
          <ProjectIcon />
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{project.name}</span>
    </span>
  );
}

/** Square screenshot thumbnails at the right of the description (plan §10). */
export function ThumbnailStack({ images }: { images: AttentionDetailImage[] }) {
  const visible = images.slice(0, 3);
  const extra = images.length - visible.length;
  return (
    <div className="flex shrink-0 items-center">
      <div className="flex items-center -space-x-3">
        {visible.map((img, index) => (
          <ItemMedia
            key={`${img.assetId}-${index}`}
            variant="image"
            style={{ zIndex: visible.length - index }}
            className="size-11 border bg-muted"
          >
            <img
              src={attentionImageUrl(img.assetId)}
              alt="Visual evidence attachment"
              aria-label={img.alt?.trim() || "Visual evidence attachment"}
              loading="lazy"
            />
          </ItemMedia>
        ))}
      </div>
      {extra > 0 && (
        <Badge variant="secondary" className="ml-1">
          +{extra}
        </Badge>
      )}
    </div>
  );
}

/**
 * Larger image gallery shown when a row is expanded (PAP-13544). Shows the
 * first three screenshots at a readable size; if more exist, an "n more" tile
 * links through to the task where the full set lives.
 */
export function ExpandedImages({
  images,
  taskRouteTarget,
}: {
  images: AttentionDetailImage[];
  taskRouteTarget: Extract<CompanyBoardRouteTarget, { kind: "task" }> | null;
}) {
  const visible = images.slice(0, 3);
  const extra = images.length - visible.length;
  return (
    <div className="flex flex-wrap items-stretch gap-2" data-attention-expanded-images="true">
      {visible.map((img, index) => {
        const src = attentionImageUrl(img.assetId);
        const key = `${img.assetId}-${index}`;
        const image = (
          <Item variant="outline" className="h-32 w-44 overflow-hidden p-0">
            <ItemMedia variant="image" className="size-full rounded-none">
              <img
                src={src}
                alt="Visual evidence attachment"
                aria-label={img.alt?.trim() || "Visual evidence attachment"}
                loading="lazy"
              />
            </ItemMedia>
          </Item>
        );
        return taskRouteTarget ? (
          <CompanyBoardLink
            key={key}
            routeTarget={taskRouteTarget}
            className="block rounded-md focus-visible:ring-ring focus-visible:ring-(length:--rad-3) focus-visible:outline-none"
            onClick={(e) => e.stopPropagation()}
          >
            {image}
          </CompanyBoardLink>
        ) : (
          <span key={key} className="block">
            {image}
          </span>
        );
      })}
      {extra > 0 &&
        (taskRouteTarget ? (
          <CompanyBoardLink
            routeTarget={taskRouteTarget}
            onClick={(e) => e.stopPropagation()}
            className="block"
          >
            <Item variant="muted" className="h-32 w-24 justify-center">
              <ItemContent className="items-center text-center">
                <ItemTitle>{extra} more</ItemTitle>
                <ItemDescription className="inline-flex items-center gap-1 text-(length:--text-nano)">
                  View task
                  <ExternalLink className="h-3 w-3" />
                </ItemDescription>
              </ItemContent>
            </Item>
          </CompanyBoardLink>
        ) : (
          <Item variant="muted" className="h-32 w-24 justify-center">
            <ItemTitle>{extra} more</ItemTitle>
          </Item>
        ))}
    </div>
  );
}
