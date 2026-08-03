# Teams Catalog Migration

The team catalog contains portable board configuration only. Catalog entries
may create ordinary agent, project, routine, and genuine company-skill records
through authenticated board import.

Retired Paperclip operational skills and agent instruction templates are not migration
inputs or fallback sources. A catalog import does not install a generic
Paperclip REST skill, seed a provider instruction, grant a role-derived
capability, choose a privileged root agent, or create provider credentials.

Each imported agent must resolve to:

- explicit adapter and provider-target configuration for every selected agent;
- explicit context, action, and mention grant values (absent means false);
- an explicit selected set of exact-version genuine company skills;
- explicit project/workspace policy where applicable; and
- an ordinary lifecycle record with no managed identity shortcut.

Every `AGENTS.md` in the shipped catalog contains only identity frontmatter:
`name`, `slug`, optional display `title`, `reportsTo`, and optional
`capabilities`. Persona prose, operating instructions, heartbeat mandates,
skill selections, adapter defaults, and role fields are rejected by catalog
validation. A missing adapter or team target blocks preview/install with a
visible configuration error; no environment variable or built-in adapter fills
the gap.

Imports validate the current catalog schema directly. Removed field names are
rejected rather than translated through a compatibility map. Existing legacy
installations are handled by the database cutover, not by catalog content.
