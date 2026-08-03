import type { Meta, StoryObj } from "@storybook/react-vite";
import { IssueChatUxLab } from "@/pages/IssueChatUxLab";
import { InviteUxLab } from "@/pages/InviteUxLab";

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">{children}</main>
    </div>
  );
}

const meta = {
  title: "UX Labs/Converted Test Pages",
  parameters: {
    docs: {
      description: {
        component:
          "The former in-app UX test routes are represented here as Storybook stories so fixture-backed review surfaces stay out of production routing.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const IssueChatReviewSurface: Story = {
  name: "Issue Chat Review Surface",
  render: () => (
    <StoryFrame>
      <IssueChatUxLab />
    </StoryFrame>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Exercises assistant-ui issue chat states: timeline events, grouped run progress, queued message, feedback controls, submitting bubble, empty state, and disabled composer.",
      },
    },
  },
};

export const InviteAndAccessFlow: Story = {
  name: "Invite And Access Flow",
  render: () => (
    <StoryFrame>
      <InviteUxLab />
    </StoryFrame>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Exercises invitation and access UX states with fixture-backed role choices, landing frames, history, and failure treatments.",
      },
    },
  },
};
