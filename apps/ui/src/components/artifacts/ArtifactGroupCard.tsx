import { Layers } from "lucide-react";
import type { CompanyArtifactGroup } from "@/api/artifacts";
import { Link, type RegisteredRouter, type ValidateLinkOptions } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ArtifactPreview } from "@/components/artifacts/ArtifactCard";
import { formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface ArtifactGroupCardProps<TRouter extends RegisteredRouter = RegisteredRouter, TOptions = unknown> {
  group: CompanyArtifactGroup;
  /** Native destination for opening this stack while preserving active search state. */
  linkOptions: ValidateLinkOptions<TRouter, TOptions>;
}

/**
 * A stack card rendered in grouped mode. It mirrors the dimensions and preview
 * of {@link ArtifactCard} so grouped and flat grids share the same rhythm, and
 * layers a subtle "stack" effect behind the card only when it represents more
 * than one artifact.
 */
export function ArtifactGroupCard<TRouter extends RegisteredRouter, TOptions>(
  props: ArtifactGroupCardProps<TRouter, TOptions>,
): ReactNode;
export function ArtifactGroupCard({ group, linkOptions }: ArtifactGroupCardProps) {
  const stacked = group.count > 1;
  const preview = group.previewArtifacts[0];
  const countLabel = `${group.count} artifact${group.count === 1 ? "" : "s"}`;

  return (
    <div className="relative">
      {stacked ? (
        <>
          <div
            aria-hidden="true"
            data-testid="artifact-stack-layer"
            className="pointer-events-none absolute inset-0 translate-x-(--sz-8px) translate-y-(--sz-8px) rounded-lg border border-border bg-muted/70"
          />
          <div
            aria-hidden="true"
            data-testid="artifact-stack-layer"
            className="pointer-events-none absolute inset-0 translate-x-(--sz-4px) translate-y-(--sz-4px) rounded-lg border border-border bg-muted/40"
          />
        </>
      ) : null}

      <Card title={countLabel} className="group relative cursor-pointer gap-0 overflow-hidden py-0">
        <Link
          {...linkOptions}
          aria-label={`Open ${group.title}`}
          data-testid="artifact-group-card"
          data-group-id={group.id}
          data-count={group.count}
          data-stacked={stacked ? "true" : "false"}
          className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="sr-only">{countLabel}</span>
        </Link>
        <div className="relative">
          {preview ? (
            <ArtifactPreview artifact={preview} />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center bg-accent/20 text-muted-foreground/50">
              <Layers className="h-7 w-7" aria-hidden="true" />
            </div>
          )}
          <Badge
            variant="ghost"
            className="absolute right-2 top-2 bg-background/85 text-(length:--text-micro) text-foreground/90 shadow-sm backdrop-blur"
          >
            <Layers className="h-3 w-3" aria-hidden="true" />
            {group.count}
          </Badge>
        </div>

        <CardContent className="flex flex-1 flex-col gap-1 p-3">
          <div className="flex h-7 items-center gap-2">
            <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
              {group.task.identifier}
            </span>
            <h3
              className="min-w-0 flex-1 truncate text-sm font-medium leading-7 text-foreground/85"
              title={group.title}
            >
              {group.title}
            </h3>
          </div>

          <div className="mt-0.5 flex items-center gap-1.5 text-(length:--text-micro) text-muted-foreground/65">
            <span>{countLabel}</span>
            <span className="text-muted-foreground/50">·</span>
            <span>Updated {formatDate(group.updatedAt)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
