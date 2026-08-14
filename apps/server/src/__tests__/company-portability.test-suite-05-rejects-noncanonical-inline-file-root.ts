import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, canonicalCompanyExtensionYaml } = t;
const { inlineSource, AGENTS_ONLY_INCLUDE } = t;
const { expect, canonicalAgentExtensionYaml, codexTargetAdapter, projectSvc } = t;
const { asTextFile, vi, companySvc, agentSvc, assetSvc, accessSvc } = t;

import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("rejects noncanonical inline file, root, selection, and include paths", async () => {
    const portability = companyPortabilityService({} as any);
    const canonicalManifest = ['schema: "paperclip/v1"', ...canonicalCompanyExtensionYaml(), ""].join("\n");
    const request = (
      files: Record<string, testSupport.CompanyPortabilityFileEntry>,
      rootPath = "portable-company",
      selectedFiles?: string[],
    ) =>
      portability.previewImport({
        source: { type: "inline", rootPath, files },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: false,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Portable company",
        },
        selectedFiles,
      });
    const canonicalFiles = {
      "COMPANY.md": "---\nname: Portable company\n---\n",
      ".paperclip.yaml": canonicalManifest,
    };

    await expect(request({ ...canonicalFiles, "./agents/lead/AGENTS.md": "" })).rejects.toThrow(
      "Package file path is not an exact portable relative path",
    );
    await expect(request(canonicalFiles, " portable-company")).rejects.toThrow(
      "Inline source root path is not an exact portable relative path",
    );
    await expect(
      request({
        "portable-company/COMPANY.md": canonicalFiles["COMPANY.md"],
        "portable-company/.paperclip.yaml": canonicalManifest,
      }),
    ).rejects.toThrow("must be relative to inline source root portable-company");
    await expect(request(canonicalFiles, "portable-company", [])).rejects.toThrow(
      "Selected files must contain at least one path",
    );
    await expect(request(canonicalFiles, "portable-company", ["./COMPANY.md"])).rejects.toThrow(
      "Selected file path is not an exact portable relative path",
    );
    await expect(
      request({
        ...canonicalFiles,
        "COMPANY.md": [
          "---",
          "name: Portable company",
          "includes:",
          "  - ../agents/lead/AGENTS.md",
          "---",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow("Company include path is not an exact portable relative path");
    await expect(
      request({
        ...canonicalFiles,
        "COMPANY.md": [
          "---",
          "name: Portable company",
          "includes:",
          "  - path: agents/lead/AGENTS.md",
          "---",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow("Company include 1 must be a path string");
    await expect(
      request({
        ...canonicalFiles,
        "COMPANY.md": [
          "---",
          "name: Portable company",
          "includes:",
          "  - agents/lead/AGENTS.md",
          "  - agents/lead/AGENTS.md",
          "---",
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow("Company include path is duplicated: agents/lead/AGENTS.md");
    await expect(
      request({
        ...canonicalFiles,
        ".paperclip.yaml": [
          'schema: "paperclip/v1"',
          "company:",
          '  budgetCurrency: "USD"',
          '  budgetMonthlyAmount: "0"',
          '  logo: "images/company-logo.png"',
          "",
        ].join("\n"),
      }),
    ).rejects.toThrow("Company manifest contains unsupported fields: logo");
  });

  it("rejects retired agent role frontmatter", async () => {
    const portability = companyPortabilityService({} as any);

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "legacy-role-package",
          files: {
            "COMPANY.md": ["---", 'schema: "agentcompanies/v1"', 'name: "Legacy Role Test"', "---", ""].join(
              "\n",
            ),
            "agents/legacy-agent/AGENTS.md": [
              "---",
              'name: "Legacy Agent"',
              'role: "retired-value"',
              "reportsTo: null",
              "---",
              "",
              "# Legacy Agent",
              "",
              "You run the company.",
              "",
            ].join("\n"),
            ".paperclip.yaml": [
              'schema: "paperclip/v1"',
              ...canonicalCompanyExtensionYaml(),
              "agents:",
              "  legacy-agent:",
              ...canonicalAgentExtensionYaml(),
              "",
            ].join("\n"),
          },
        },
        include: AGENTS_ONLY_INCLUDE,
        target: { mode: "new_company", newCompanyName: "Legacy Role Test" },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          "legacy-agent": codexTargetAdapter(),
        },
      }),
    ).rejects.toThrow("contains unsupported fields: role");
  });

  it("treats no-separator auth and api key env names as secrets during export", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        description: "Ship it",
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        env: {
          APIKEY: {
            type: "plain",
            value: "sk-plain-api",
          },
          GITHUBAUTH: {
            type: "plain",
            value: "gh-auth-token",
          },
          PRIVATEKEY: {
            type: "plain",
            value: "private-key-value",
          },
        },
        metadata: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: false,
        agents: false,
        projects: true,
        tasks: false,
      },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("APIKEY:");
    expect(extension).toContain("GITHUBAUTH:");
    expect(extension).toContain("PRIVATEKEY:");
    expect(extension).not.toContain("sk-plain-api");
    expect(extension).not.toContain("gh-auth-token");
    expect(extension).not.toContain("private-key-value");
    expect(extension).toContain('kind: "secret"');
  });

  it("imports a packaged company logo and attaches it to the target company", async () => {
    const storage = {
      putFile: vi.fn().mockResolvedValue({
        provider: "local_disk",
        objectKey: "assets/companies/imported-logo",
        contentType: "image/png",
        byteSize: 9,
        sha256: "logo-sha",
        originalFilename: "company-logo.png",
      }),
    };
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: null,
    });
    companySvc.update.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
      logoAssetId: "asset-created",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const portability = companyPortabilityService({} as any, storage as any);
    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    exported.files["images/company-logo.png"] = {
      encoding: "base64",
      data: Buffer.from("png-bytes").toString("base64"),
      contentType: "image/png",
    };
    exported.files[".paperclip.yaml"] = `${exported.files[".paperclip.yaml"]}`.replace(
      'brandColor: "#5c5fff"\n',
      'brandColor: "#5c5fff"\n  logoPath: "images/company-logo.png"\n',
    );

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: inlineSource(exported),
        include: AGENTS_ONLY_INCLUDE,
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
          reviewer: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(storage.putFile).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-imported",
        namespace: "assets/companies",
        originalFilename: "company-logo.png",
        contentType: "image/png",
        body: Buffer.from("png-bytes"),
      }),
    );
    expect(assetSvc.create).toHaveBeenCalledWith(
      "company-imported",
      expect.objectContaining({
        objectKey: "assets/companies/imported-logo",
        contentType: "image/png",
        createdByUserId: "user-1",
      }),
    );
    expect(companySvc.update).toHaveBeenCalledWith("company-imported", {
      logoAssetId: "asset-created",
    });
  });

  it("copies source company memberships for safe new-company imports", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });

    const exported = await portability.exportBundle("company-1", {
      include: AGENTS_ONLY_INCLUDE,
    });

    agentSvc.list.mockResolvedValue([]);

    await portability.importBundle(
      {
        source: inlineSource(exported),
        include: AGENTS_ONLY_INCLUDE,
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
          reviewer: codexTargetAdapter(),
        },
      },
      null,
      {
        mode: "agent_safe",
        sourceCompanyId: "company-1",
      },
    );

    expect(accessSvc.listActiveUserMemberships).toHaveBeenCalledWith("company-1");
    expect(accessSvc.copyActiveUserMemberships).toHaveBeenCalledWith("company-1", "company-imported");
    expect(accessSvc.ensureMembership).not.toHaveBeenCalledWith(
      "company-imported",
      "user",
      expect.anything(),
      "owner",
      "active",
    );
  });
});
