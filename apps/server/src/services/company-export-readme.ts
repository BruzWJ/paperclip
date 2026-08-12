/** Generates README.md for company exports. */
import type { CompanyPortabilityManifest } from "@paperclipai/shared";

export type CompanyReadmeAgent = Pick<
  CompanyPortabilityManifest["agents"][number],
  "slug" | "name" | "title" | "reportsToSlug"
>;

export interface CompanyReadmeManifest {
  agents: CompanyReadmeAgent[];
  projects: Array<
    Pick<CompanyPortabilityManifest["projects"][number], "name" | "description">
  >;
  tasks: Array<unknown>;
}

/**
 * Generate the README.md content for a company export.
 */
export function generateReadme(
  manifest: CompanyReadmeManifest,
  options: {
    companyName: string;
    companyDescription: string | null;
  },
): string {
  const lines: string[] = [];

  lines.push(`# ${options.companyName}`);
  lines.push("");
  if (options.companyDescription) {
    lines.push(`> ${options.companyDescription}`);
    lines.push("");
  }

  // Org chart image (generated during export as images/org-chart.png)
  if (manifest.agents.length > 0) {
    lines.push("![Org Chart](images/org-chart.png)");
    lines.push("");
  }

  // What's Inside table
  lines.push("## What's Inside");
  lines.push("");
  lines.push(
    "> This is an [Agent Company](https://agentcompanies.io) package from [Paperclip](https://paperclip.ing)",
  );
  lines.push("");

  const counts: Array<[string, number]> = [];
  if (manifest.agents.length > 0)
    counts.push(["Agents", manifest.agents.length]);
  if (manifest.projects.length > 0)
    counts.push(["Projects", manifest.projects.length]);
  if (manifest.tasks.length > 0) counts.push(["Tasks", manifest.tasks.length]);

  if (counts.length > 0) {
    lines.push("| Content | Count |");
    lines.push("|---------|-------|");
    for (const [label, count] of counts) {
      lines.push(`| ${label} | ${count} |`);
    }
    lines.push("");
  }

  // Agents table
  if (manifest.agents.length > 0) {
    lines.push("### Agents");
    lines.push("");
    lines.push("| Agent | Title | Reports To |");
    lines.push("|-------|------|------------|");
    for (const agent of manifest.agents) {
      const reportsTo = agent.reportsToSlug ?? "\u2014";
      lines.push(
        `| ${agent.name} | ${agent.title ?? "\u2014"} | ${reportsTo} |`,
      );
    }
    lines.push("");
  }

  // Projects list
  if (manifest.projects.length > 0) {
    lines.push("### Projects");
    lines.push("");
    for (const project of manifest.projects) {
      const desc = project.description ? ` \u2014 ${project.description}` : "";
      lines.push(`- **${project.name}**${desc}`);
    }
    lines.push("");
  }

  // Getting Started
  lines.push("## Getting Started");
  lines.push("");
  lines.push("```bash");
  lines.push("pnpm paperclipai company import this-github-url-or-folder");
  lines.push("```");
  lines.push("");
  lines.push("See [Paperclip](https://paperclip.ing) for more information.");
  lines.push("");

  // Footer
  lines.push("---");
  lines.push(
    `Exported from [Paperclip](https://paperclip.ing) on ${new Date().toISOString().split("T")[0]}`,
  );
  lines.push("");

  return lines.join("\n");
}
