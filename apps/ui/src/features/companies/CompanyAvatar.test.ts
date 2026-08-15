import { PROJECT_COLORS } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { createCompanyAvatarDataUri } from "./CompanyAvatar";

describe("createCompanyAvatarDataUri", () => {
  it("creates deterministic Glass avatars that honor the company brand color", () => {
    const brandColor = PROJECT_COLORS[0];
    const first = createCompanyAvatarDataUri("Acme Labs", brandColor);
    const repeated = createCompanyAvatarDataUri("Acme Labs", brandColor);
    const recolored = createCompanyAvatarDataUri("Acme Labs", PROJECT_COLORS[1]);

    expect(first).toBe(repeated);
    expect(first).not.toBe(recolored);
    expect(first).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(first)).toContain(brandColor);
  });

  it("keeps the auto-generated Glass avatar stable when no brand color is set", () => {
    const first = createCompanyAvatarDataUri("Acme Labs");

    expect(createCompanyAvatarDataUri("Acme Labs")).toBe(first);
    expect(createCompanyAvatarDataUri("Strata")).not.toBe(first);
  });
});
