import { expect, test } from "./fixtures";

test.describe("Multi-user account and membership projection", () => {
  test("projects signup, invite acceptance, and role changes through the mocked API boundary", async ({
    page,
    request,
  }) => {
    const owner = await request.post("/api/auth/sign-up/email", {
      data: {
        name: "Owner User",
        email: "owner@paperclip.test",
        password: "paperclip-owner-password",
      },
    });
    expect(owner.ok()).toBe(true);

    const companyResponse = await request.post("/api/companies", {
      data: { name: "Multi-user fixture" },
    });
    expect(companyResponse.ok()).toBe(true);
    const company = (await companyResponse.json()) as {
      id: string;
    };

    const inviteResponse = await request.post(
      `/api/companies/${company.id}/invites`,
      { data: { userRole: "operator" } },
    );
    expect(inviteResponse.ok()).toBe(true);
    const invite = (await inviteResponse.json()) as { token: string };

    const recipient = await request.post("/api/auth/sign-up/email", {
      data: {
        name: "Invited User",
        email: "invitee@paperclip.test",
        password: "paperclip-invitee-password",
      },
    });
    expect(recipient.ok()).toBe(true);

    const acceptedResponse = await request.post(
      `/api/invites/${invite.token}/accept`,
      { data: {} },
    );
    expect(acceptedResponse.ok()).toBe(true);
    const accepted = (await acceptedResponse.json()) as {
      id: string;
      status: string;
      requestEmailSnapshot: string;
    };
    expect(accepted).toMatchObject({
      status: "approved",
      requestEmailSnapshot: "invitee@paperclip.test",
    });

    const membersBeforeUpdate = await request.get(
      `/api/companies/${company.id}/members`,
    );
    expect(membersBeforeUpdate.ok()).toBe(true);
    const member = (
      (await membersBeforeUpdate.json()) as {
        members: Array<{
          id: string;
          membershipRole: string;
          user: { email: string };
        }>;
      }
    ).members.find(
      (candidate) => candidate.user.email === "invitee@paperclip.test",
    );
    expect(member).toBeDefined();
    expect(member?.membershipRole).toBe("operator");

    const update = await request.patch(
      `/api/companies/${company.id}/members/${member!.id}`,
      { data: { membershipRole: "viewer" } },
    );
    expect(update.ok()).toBe(true);
    await expect(update.json()).resolves.toMatchObject({
      id: member!.id,
      membershipRole: "viewer",
    });

    const members = await request.get(`/api/companies/${company.id}/members`);
    expect(members.ok()).toBe(true);
    await expect(members.json()).resolves.toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          id: member!.id,
          membershipRole: "viewer",
        }),
      ]),
    });

    await page.goto(`/${company.id}/company/settings`);
    await expect(
      page.getByRole("heading", { name: /Company settings/i }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
