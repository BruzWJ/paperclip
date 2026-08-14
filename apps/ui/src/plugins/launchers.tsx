import type { PluginLauncherPlacementZone, PluginUiSlotEntityType } from "@paperclipai/shared";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { PluginMountContext } from "./bridge";
import { getPluginLauncherErrorMessage, usePluginLaunchers } from "./plugin-launcher-discovery";
import { usePluginLauncherRuntime } from "./PluginLauncherProvider";

export type { ResolvedPluginLauncher } from "./plugin-launcher-types";
export { PluginLauncherProvider } from "./PluginLauncherProvider";

function launcherTriggerClassName(placementZone: PluginLauncherPlacementZone): string {
  return placementZone === "sidebar" ? "justify-start h-8 w-full" : "h-8";
}

export type PluginLauncherOutletProps = {
  placementZones: PluginLauncherPlacementZone[];
  context: PluginMountContext;
  entityType?: PluginUiSlotEntityType | null;
  className?: string;
  itemClassName?: string;
  errorClassName?: string;
};

export function PluginLauncherOutlet({
  placementZones,
  context,
  entityType,
  className,
  itemClassName,
  errorClassName,
}: PluginLauncherOutletProps) {
  const [activationError, setActivationError] = useState<string | null>(null);
  const { activateLauncher } = usePluginLauncherRuntime();
  const { launchers, contributionsByPluginId, errorMessage } = usePluginLaunchers({
    placementZones,
    entityType,
    enabled: !!context.companyId,
  });

  if (errorMessage) {
    return (
      <Alert variant="destructive" className={errorClassName}>
        <AlertDescription>Plugin launchers unavailable: {errorMessage}</AlertDescription>
      </Alert>
    );
  }
  if (launchers.length === 0) return null;

  return (
    <div className={className}>
      {activationError ? (
        <Alert variant="destructive" className={errorClassName}>
          <AlertDescription>Plugin launcher failed: {activationError}</AlertDescription>
        </Alert>
      ) : null}
      {launchers.map((launcher) => (
        <div
          key={`${launcher.pluginId}:${launcher.pluginUpdatedAt}:${launcher.id}`}
          className={itemClassName}
        >
          <Button
            type="button"
            variant={
              launcher.placementZone === "toolbarButton" || launcher.placementZone === "globalToolbarButton"
                ? "outline"
                : "ghost"
            }
            size="sm"
            className={launcherTriggerClassName(launcher.placementZone)}
            onClick={(event) => {
              setActivationError(null);
              const contribution = contributionsByPluginId.get(launcher.pluginId);
              if (!contribution) {
                setActivationError(`Missing contribution metadata for plugin "${launcher.pluginKey}".`);
                return;
              }
              void activateLauncher(launcher, context, contribution, event.currentTarget).catch(
                (error: unknown) => {
                  setActivationError(getPluginLauncherErrorMessage(error));
                },
              );
            }}
          >
            {launcher.displayName}
          </Button>
        </div>
      ))}
    </div>
  );
}
