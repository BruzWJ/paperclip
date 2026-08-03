import { defineConfig } from "vitest/config";
import { discoverVitestProjectManifest } from "./scripts/vitest-project-manifest.mjs";

const repositoryRoot = import.meta.dirname;
const { projects } = discoverVitestProjectManifest(repositoryRoot);

export default defineConfig({
  envDir: false,
  test: {
    projects: projects.map((project) => project.path),
  },
});
