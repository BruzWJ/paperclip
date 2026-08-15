import {
  SidebarProvider as ShadcnSidebarProvider,
  useSidebar as useShadcnSidebar,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

interface SidebarContextValue {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  isMobile: boolean;
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
  collapseLocked: boolean;
  peeking: boolean;
  setPeeking: (next: boolean) => void;
  setPeekHeld: (next: boolean) => void;
  forceCollapsed: boolean;
  setForceCollapsed: (next: boolean) => void;
  routeRequestsCollapsed: boolean;
  setRouteRequestsCollapsed: (next: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);
const COLLAPSED_STORAGE_KEY = "paperclip.sidebar.collapsed";
const PEEK_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

function readStoredCollapsed(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    return stored === "1" ? true : stored === "0" ? false : null;
  } catch {
    return null;
  }
}

function writeStoredCollapsed(value: boolean) {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Pinning remains session-local when storage is unavailable.
  }
}

function readPointerCanPeek() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(PEEK_POINTER_QUERY).matches;
  } catch {
    return false;
  }
}

type SidebarBridgeProps = Omit<SidebarContextValue, "sidebarOpen" | "setSidebarOpen" | "toggleSidebar"> & {
  children: ReactNode;
};

/** Adds Paperclip's desktop visibility control to shadcn's mobile Sheet state. */
function SidebarBridge({ children, ...domainState }: SidebarBridgeProps) {
  const { openMobile, setOpenMobile } = useShadcnSidebar();
  const [desktopOpen, setDesktopOpen] = useState(true);
  const { isMobile } = domainState;

  useEffect(() => {
    if (!isMobile) setDesktopOpen(true);
  }, [isMobile]);

  const setSidebarOpen = useCallback(
    (open: boolean) => {
      if (isMobile) setOpenMobile(open);
      else setDesktopOpen(open);
    },
    [isMobile, setOpenMobile],
  );
  const toggleSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(!openMobile);
    else setDesktopOpen((open) => !open);
  }, [isMobile, openMobile, setOpenMobile]);

  const value = useMemo<SidebarContextValue>(
    () => ({
      ...domainState,
      sidebarOpen: isMobile ? openMobile : desktopOpen,
      setSidebarOpen,
      toggleSidebar,
    }),
    [domainState, desktopOpen, isMobile, openMobile, setSidebarOpen, toggleSidebar],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

/**
 * Thin domain adapter over shadcn SidebarProvider. The primitive owns the mobile
 * Sheet, controlled expanded state, and Cmd/Ctrl+B shortcut. This adapter only
 * resolves Paperclip's force/route/user precedence and hover-peek capability.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(() => readStoredCollapsed());
  const [routeRequestsCollapsed, setRouteRequestsCollapsed] = useState(false);
  const [forceCollapsed, setForceCollapsed] = useState(false);
  const [rawPeeking, setPeeking] = useState(false);
  const [peekHeld, setPeekHeld] = useState(false);
  const [pointerCanPeek, setPointerCanPeek] = useState(readPointerCanPeek);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(PEEK_POINTER_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setPointerCanPeek(true);
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  // iPadOS does not update the hover media query for an attached trackpad.
  useEffect(() => {
    if (pointerCanPeek || typeof window.PointerEvent !== "function") return;
    const handlePointer = (event: PointerEvent) => {
      if (event.pointerType === "mouse") setPointerCanPeek(true);
    };
    window.addEventListener("pointerover", handlePointer, { passive: true });
    window.addEventListener("pointermove", handlePointer, { passive: true });
    return () => {
      window.removeEventListener("pointerover", handlePointer);
      window.removeEventListener("pointermove", handlePointer);
    };
  }, [pointerCanPeek]);

  const pinnedOrRequested = userCollapsed !== null ? userCollapsed : routeRequestsCollapsed;
  const desktopCollapsed = forceCollapsed || pinnedOrRequested;
  const collapsed = !isMobile && desktopCollapsed;
  const collapseLocked = !isMobile && forceCollapsed;
  const peeking = (rawPeeking || peekHeld) && collapsed && pointerCanPeek;

  const setCollapsed = useCallback((next: boolean) => {
    setUserCollapsed(next);
    writeStoredCollapsed(next);
  }, []);
  const toggleCollapsed = useCallback(() => {
    if (!forceCollapsed) setCollapsed(!pinnedOrRequested);
  }, [forceCollapsed, pinnedOrRequested, setCollapsed]);
  const handlePrimitiveOpenChange = useCallback(
    (open: boolean) => {
      if (!isMobile && !forceCollapsed) setCollapsed(!open);
    },
    [forceCollapsed, isMobile, setCollapsed],
  );

  const domainState = useMemo<SidebarBridgeProps>(
    () => ({
      children,
      isMobile,
      collapsed,
      setCollapsed,
      toggleCollapsed,
      collapseLocked,
      peeking,
      setPeeking,
      setPeekHeld,
      forceCollapsed,
      setForceCollapsed,
      routeRequestsCollapsed,
      setRouteRequestsCollapsed,
    }),
    [
      children,
      collapseLocked,
      collapsed,
      forceCollapsed,
      isMobile,
      peeking,
      routeRequestsCollapsed,
      setCollapsed,
      toggleCollapsed,
    ],
  );

  return (
    <ShadcnSidebarProvider
      open={!desktopCollapsed}
      onOpenChange={handlePrimitiveOpenChange}
      className="contents"
      style={
        {
          "--sidebar-width": "15rem",
          "--sidebar-width-icon": "4rem",
        } as CSSProperties
      }
    >
      <SidebarBridge {...domainState} />
    </ShadcnSidebarProvider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within SidebarProvider");
  return context;
}
