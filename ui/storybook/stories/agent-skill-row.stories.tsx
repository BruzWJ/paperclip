import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Folder, Github } from "lucide-react";
import { AgentSkillRow, type AgentSkillRowData } from "@/pages/agent-skills/AgentSkillRow";

const ENABLED: AgentSkillRowData = {
  key: "agent-browser",
  name: "agent-browser",
  icon: { key: "agent-browser", name: "agent-browser", slug: "agent-browser", iconUrl: null, color: null },
  summary: "Drive a real browser to inspect and interact with web pages.",
  chip: "automation",
  sourceMeta: { icon: Github, label: "GitHub · vercel-labs/agent-browser" },
  linkTo: "/skills/agent-browser",
  slug: "agent-browser",
  tagline: "Drive a real browser to inspect and interact with web pages.",
  categories: ["automation"],
};

const AVAILABLE: AgentSkillRowData = {
  key: "release-notes",
  name: "release-notes",
  icon: { key: "release-notes", name: "release-notes", slug: "release-notes", iconUrl: null, color: "#7c3aed" },
  summary: "Draft concise release notes from a selected change set.",
  chip: "writing",
  sourceMeta: { icon: Folder, label: "Local folder" },
  linkTo: "/skills/release-notes",
  slug: "release-notes",
  tagline: "Draft concise release notes from a selected change set.",
  categories: ["writing"],
};

const READONLY: AgentSkillRowData = {
  key: "user-installed-linter",
  name: "user-installed-linter",
  icon: { key: "user-installed-linter", name: "user-installed-linter", slug: null, iconUrl: null, color: null },
  summary: "Detected in the adapter's skill directory.",
  chip: null,
  linkTo: null,
  originLabel: "User-installed",
  locationLabel: "~/.claude/skills/linter",
};

const meta: Meta<typeof AgentSkillRow> = {
  title: "Agent Skills/AgentSkillRow",
  component: AgentSkillRow,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl overflow-hidden rounded-lg border border-border">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof AgentSkillRow>;

function ToggleableRow({ data, initial }: { data: AgentSkillRowData; initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  return (
    <AgentSkillRow
      variant={checked ? "enabled" : "available"}
      data={data}
      checked={checked}
      onCheckedChange={setChecked}
    />
  );
}

export const Enabled: Story = {
  render: () => <ToggleableRow data={ENABLED} initial={true} />,
};

export const Available: Story = {
  render: () => <ToggleableRow data={AVAILABLE} initial={false} />,
};

export const ReadOnly: Story = {
  args: { variant: "readonly", data: READONLY },
};

export const DisabledUnsupported: Story = {
  args: {
    variant: "available",
    data: AVAILABLE,
    checked: false,
    disabled: true,
    disabledReason: "Paperclip cannot manage skills for this adapter yet.",
  },
};

export const AllVariants: Story = {
  render: () => (
    <>
      <ToggleableRow data={ENABLED} initial={true} />
      <ToggleableRow data={AVAILABLE} initial={false} />
      <AgentSkillRow variant="readonly" data={READONLY} />
    </>
  ),
};
