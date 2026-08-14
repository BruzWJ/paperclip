import { useSidebar } from "@/context/SidebarContext";
import { toast } from "sonner";
import type {
  HostLocation,
  HostNavigation,
  HostNavigationLinkOptions,
  HostNavigationLinkProps,
  HostNavigationOptions,
  PluginHostContext,
  PluginToastFn,
  PluginToastInput,
} from "@paperclipai/plugin-sdk/ui";
import { resolvePluginNavigationHref } from "@paperclipai/shared";
import { useLocation as useRouterLocation, useNavigate as useRouterNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { usePluginBridgeContext } from "./bridge-core";

function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey
  );
}

export function shouldHandleHostNavigationClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  href: string,
  target?: string,
): boolean {
  if (!isPlainLeftClick(event)) return false;
  if (target && target !== "_self") return false;
  if (event.currentTarget.hasAttribute("download")) return false;
  return href.startsWith("/") && !href.startsWith("//");
}

// ---------------------------------------------------------------------------
// useHostContext — concrete implementation
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `useHostContext()`.
 *
 * Returns the current host context (company, project, entity, user)
 * from the enclosing `PluginBridgeContext.Provider`.
 */
export function useHostContext(): PluginHostContext {
  const { hostContext } = usePluginBridgeContext();
  return hostContext;
}

// ---------------------------------------------------------------------------
// useHostNavigation — concrete implementation
// ---------------------------------------------------------------------------

export function useHostNavigation(): HostNavigation {
  const { hostContext } = usePluginBridgeContext();
  const routerNavigate = useRouterNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const companyId = hostContext.companyId;

  const resolveHref = useCallback((to: string) => resolvePluginNavigationHref(to, companyId), [companyId]);

  const navigateResolvedHref = useCallback(
    (href: string, options?: HostNavigationOptions) => {
      void routerNavigate({
        href,
        replace: options?.replace,
        state: options?.state,
      });
      // Mirror host sidebar behavior: tapping a link inside the mobile drawer
      // dismisses the drawer so the user can see the destination page.
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, routerNavigate, setSidebarOpen],
  );

  const navigate = useCallback(
    (to: string, options?: HostNavigationOptions) => {
      navigateResolvedHref(resolveHref(to), options);
    },
    [navigateResolvedHref, resolveHref],
  );

  const linkProps = useCallback(
    (to: string, options?: HostNavigationLinkOptions): HostNavigationLinkProps => {
      const href = resolveHref(to);
      return {
        href,
        target: options?.target,
        rel: options?.rel,
        onClick: (event) => {
          if (!shouldHandleHostNavigationClick(event, href, options?.target)) return;
          event.preventDefault();
          navigateResolvedHref(href, options);
        },
      };
    },
    [navigateResolvedHref, resolveHref],
  );

  return useMemo(
    () => ({
      resolveHref,
      navigate,
      linkProps,
    }),
    [linkProps, navigate, resolveHref],
  );
}

// ---------------------------------------------------------------------------
// useHostLocation — concrete implementation
// ---------------------------------------------------------------------------

export function useHostLocation(): HostLocation {
  const location = useRouterLocation();
  return useMemo(
    () => ({
      pathname: location.pathname,
      search: location.searchStr,
      hash: location.hash ? `#${location.hash}` : "",
      state: location.state,
    }),
    [location.hash, location.pathname, location.searchStr, location.state],
  );
}

// ---------------------------------------------------------------------------
// usePluginToast — concrete implementation
// ---------------------------------------------------------------------------

export function usePluginToast(): PluginToastFn {
  const { navigate } = useHostNavigation();
  return useCallback(
    (input: PluginToastInput) => {
      const options = {
        description: input.body,
        duration: input.ttlMs,
        id: input.id ?? input.dedupeKey,
        action: input.action
          ? {
              label: input.action.label,
              onClick: () => navigate(input.action!.href),
            }
          : undefined,
      };
      const result =
        input.tone === "success"
          ? toast.success(input.title, options)
          : input.tone === "warn"
            ? toast.warning(input.title, options)
            : input.tone === "error"
              ? toast.error(input.title, options)
              : toast.info(input.title, options);
      return String(result);
    },
    [navigate],
  );
}
