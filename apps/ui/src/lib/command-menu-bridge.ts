type CommandMenuOpener = (open: boolean) => void;

let companyCommandMenuOpener: CommandMenuOpener | null = null;

/** Lets the company board palette claim Cmd/Ctrl+K while it is mounted. */
export function registerCompanyCommandMenu(opener: CommandMenuOpener): () => void {
  companyCommandMenuOpener = opener;
  return () => {
    if (companyCommandMenuOpener === opener) {
      companyCommandMenuOpener = null;
    }
  };
}

export function openCompanyCommandMenu(): boolean {
  if (!companyCommandMenuOpener) return false;
  companyCommandMenuOpener(true);
  return true;
}
