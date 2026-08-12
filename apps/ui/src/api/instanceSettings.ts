import type {
  InstanceGeneralSettings,
  PatchInstanceGeneralSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
};
