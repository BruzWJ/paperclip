import { createContext, useContext, type ReactNode } from "react";
import type { InboxController } from "./index";
const InboxPageContext = createContext<InboxController | null>(null);
export function InboxPageProvider({ value, children }: { value: InboxController; children: ReactNode }) {
  return <InboxPageContext.Provider value={value}>{children}</InboxPageContext.Provider>;
}
export function useInboxPage(): InboxController {
  const value = useContext(InboxPageContext);
  if (!value) throw new Error("useInboxPage requires InboxPageProvider");
  return value;
}
