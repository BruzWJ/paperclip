import type { Meta, StoryObj } from "@storybook/react-vite";

import { useState } from "react";

import { Package } from "lucide-react";
import {
  Empty as EmptyRoot,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

import type { CompanyArtifact } from "@/api/artifacts";
import {
  ArtifactsGrid,
  ArtifactsToolbar,
  SAMPLE_IMAGE,
  makeArtifact,
  type StoryArtifactGroupBy,
  type StoryArtifactKindFilter,
} from "./artifact-story-support";

/**
 * Storybook coverage for the company Artifacts page. Covers:
 *  - the flat grid (PAP-10359)
 *  - the new group-by control, stack cards, and selected stack view (PAP-10440 / PAP-10442)
 *
 * Each story is renderable standalone so UX/QA can capture desktop and mobile
 * screenshots without booting a live backend.
 */

const ARTIFACTS: CompanyArtifact[] = [
  makeArtifact({
    id: "b6000000-0000-4000-8000-000000000002",
    source: "work_product",
    mediaKind: "video",
    title: "Product demo — primary cut.mp4",
    contentType: "video/mp4",
    contentPath: null,
    openPath: "/files/demo.mp4",
    downloadPath: "/files/demo.mp4?download=1",
    task: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00a",
      taskNumber: 10205,
      identifier: "PAP-10205",
      title: "Record the launch walkthrough",
    },
    taskFragment: "work-product-wp-video",
  }),
  makeArtifact({
    id: "b6000000-0000-4000-8000-000000000003",
    mediaKind: "image",
    title: "Hero render.png",
    contentType: "image/png",
    contentPath: SAMPLE_IMAGE,
    openPath: SAMPLE_IMAGE,
    downloadPath: SAMPLE_IMAGE,
  }),
  makeArtifact({
    id: "b6000000-0000-4000-8000-000000000007",
    source: "document",
    mediaKind: "document",
    title: "Artifacts Page Plan",
    previewText:
      "Build a company-level Artifacts page at /{companyId}/artifacts, with a sidebar item below Goals and a three-column artifact grid. The page should make agent-produced work easy to find without becoming another attachment dump.",
    contentType: "text/markdown",
    task: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00b",
      taskNumber: 10341,
      identifier: "PAP-10341",
      title: "Draft the rollout plan",
    },
    createdByAgent: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      name: "CodexCoder",
    },
    taskFragment: "a2000000-0000-4000-8000-000000000002",
  }),
  makeArtifact({
    id: "b6000000-0000-4000-8000-000000000008",
    mediaKind: "text",
    title: "review-notes.txt",
    previewText:
      "Reviewed the primary cut. Color grade looks good; trim the first 1.2s of dead air. Re-export at 1080p and attach the final to the task.",
    contentType: "text/plain",
    openPath: "/files/review-notes.txt",
    downloadPath: "/files/review-notes.txt?download=1",
    task: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddd00a",
      taskNumber: 10205,
      identifier: "PAP-10205",
      title: "Record the launch walkthrough",
    },
  }),
  makeArtifact({
    id: "b6000000-0000-4000-8000-00000000000a",
    mediaKind: "file",
    title: "design-assets.zip",
    contentType: "application/zip",
    openPath: "/files/design-assets.zip",
    downloadPath: "/files/design-assets.zip?download=1",
    task: {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddd009",
      taskNumber: 10306,
      identifier: "PAP-10306",
      title: "Landing visuals refresh",
    },
  }),
  makeArtifact({
    id: "b6000000-0000-4000-8000-000000000006",
    mediaKind: "image",
    title: "missing-preview.png (broken source)",
    contentType: "image/png",
    contentPath: "/files/does-not-exist.png",
    openPath: "/files/does-not-exist.png",
    downloadPath: "/files/does-not-exist.png?download=1",
  }),
];

const meta: Meta = {
  title: "Pages/Artifacts",
};

export default meta;

type Story = StoryObj;

/**
 * Flat grid (existing behaviour) — group control is set to `None` so the
 * toolbar shows the new icon in its inert state.
 */
export const Grid: Story = {
  render: () => {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<StoryArtifactKindFilter>("all");
    const [groupBy, setGroupBy] = useState<StoryArtifactGroupBy>("none");
    return (
      <div className="mx-auto w-full max-w-6xl space-y-5 p-6">
        <ArtifactsToolbar
          query={query}
          onQueryChange={setQuery}
          kind={kind}
          onKindChange={setKind}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
        />
        <ArtifactsGrid artifacts={ARTIFACTS} />
      </div>
    );
  },
};

export const Empty: Story = {
  render: () => (
    <div className="mx-auto max-w-6xl p-6">
      <EmptyRoot>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Package />
          </EmptyMedia>
          <EmptyTitle>No artifacts yet</EmptyTitle>
          <EmptyDescription>Agent-produced documents, media, and files will appear here.</EmptyDescription>
        </EmptyHeader>
      </EmptyRoot>
    </div>
  ),
};
