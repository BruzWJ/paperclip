import { createContext, useContext, type ReactNode } from "react";

import type { SecretsController } from "./index";

const SecretsPageContext = createContext<SecretsController | null>(null);

export function SecretsPageProvider({ value, children }: { value: SecretsController; children: ReactNode }) {
  return <SecretsPageContext.Provider value={value}>{children}</SecretsPageContext.Provider>;
}

export function useSecretsPage(): SecretsController {
  const value = useContext(SecretsPageContext);
  if (!value) {
    throw new Error("useSecretsPage must be used inside SecretsPageProvider");
  }
  return value;
}
