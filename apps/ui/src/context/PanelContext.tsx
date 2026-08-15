import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const STORAGE_KEY = "paperclip:panel-visible";

type PanelHeaderMode = "shell" | "content";

interface PanelOptions {
  title?: string;
  headerMode?: PanelHeaderMode;
}

interface PanelContextValue {
  panelContent: ReactNode | null;
  panelHeaderMode: PanelHeaderMode;
  panelTitle: string;
  panelVisible: boolean;
  openPanel: (content: ReactNode, options?: PanelOptions) => void;
  closePanel: () => void;
  setPanelVisible: (visible: boolean) => void;
  togglePanelVisible: () => void;
}

const PanelContext = createContext<PanelContextValue | null>(null);

function readPreference(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function writePreference(visible: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    // Ignore storage failures.
  }
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<{
    content: ReactNode;
    headerMode: PanelHeaderMode;
    title: string;
  } | null>(null);
  const [panelVisible, setPanelVisibleState] = useState(readPreference);

  const openPanel = useCallback((content: ReactNode, options?: PanelOptions) => {
    setPanel({
      content,
      headerMode: options?.headerMode ?? "shell",
      title: options?.title ?? "Properties",
    });
  }, []);

  const closePanel = useCallback(() => {
    setPanel(null);
  }, []);

  const setPanelVisible = useCallback((visible: boolean) => {
    setPanelVisibleState(visible);
    writePreference(visible);
  }, []);

  const togglePanelVisible = useCallback(() => {
    setPanelVisibleState((prev) => {
      const next = !prev;
      writePreference(next);
      return next;
    });
  }, []);

  return (
    <PanelContext.Provider
      value={{
        panelContent: panel?.content ?? null,
        panelHeaderMode: panel?.headerMode ?? "shell",
        panelTitle: panel?.title ?? "Properties",
        panelVisible,
        openPanel,
        closePanel,
        setPanelVisible,
        togglePanelVisible,
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanel() {
  const ctx = useContext(PanelContext);
  if (!ctx) {
    throw new Error("usePanel must be used within PanelProvider");
  }
  return ctx;
}
