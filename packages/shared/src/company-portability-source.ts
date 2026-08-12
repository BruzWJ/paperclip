export const CANONICAL_GITHUB_IMPORT_SOURCE_GRAMMAR =
  "https://<github-host>/<owner>/<repo>?ref=<ref>[&path=<package-directory>]";

export type CanonicalGithubImportSource = {
  hostname: string;
  owner: string;
  repo: string;
  ref: string;
  basePath: string;
  companyPath: string;
};

function canonicalGithubImportSourceError(): Error {
  return new Error(
    `GitHub source must use the exact canonical URL grammar ${CANONICAL_GITHUB_IMPORT_SOURCE_GRAMMAR}.`,
  );
}

function isCanonicalGithubHost(hostname: string): boolean {
  return (
    hostname.length <= 253 &&
    hostname
      .split(".")
      .every((label) =>
        /^(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/.test(label),
      )
  );
}

function isCanonicalGithubRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/")
  );
}

function isCanonicalGithubPackagePath(sourcePath: string): boolean {
  return sourcePath
    .split("/")
    .every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(segment),
    );
}

export function parseCanonicalGithubImportSourceUrl(
  input: string,
): CanonicalGithubImportSource {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw canonicalGithubImportSourceError();
  }

  if (
    input.length === 0 ||
    input.trim() !== input ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !isCanonicalGithubHost(url.hostname)
  ) {
    throw canonicalGithubImportSourceError();
  }

  const pathMatch =
    /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(
      url.pathname,
    );
  if (!pathMatch || pathMatch[2]!.toLowerCase().endsWith(".git")) {
    throw canonicalGithubImportSourceError();
  }

  const queryEntries = [...url.searchParams.entries()];
  const queryKeys = queryEntries.map(([key]) => key);
  if (
    (queryKeys.length !== 1 && queryKeys.length !== 2) ||
    queryKeys[0] !== "ref" ||
    (queryKeys.length === 2 && queryKeys[1] !== "path") ||
    new Set(queryKeys).size !== queryKeys.length ||
    queryEntries.some(
      ([, value]) => value.length === 0 || value.trim() !== value,
    )
  ) {
    throw canonicalGithubImportSourceError();
  }

  const ref = url.searchParams.get("ref");
  const sourcePath = url.searchParams.get("path");
  if (
    ref === null ||
    !isCanonicalGithubRef(ref) ||
    (sourcePath !== null && !isCanonicalGithubPackagePath(sourcePath))
  ) {
    throw canonicalGithubImportSourceError();
  }

  const owner = pathMatch[1]!;
  const repo = pathMatch[2]!;
  const canonicalUrl = new URL(`https://${url.hostname}/${owner}/${repo}`);
  canonicalUrl.searchParams.set("ref", ref);
  if (sourcePath !== null) canonicalUrl.searchParams.set("path", sourcePath);
  if (canonicalUrl.toString() !== input) {
    throw canonicalGithubImportSourceError();
  }

  const basePath = sourcePath ?? "";
  return {
    hostname: url.hostname,
    owner,
    repo,
    ref,
    basePath,
    companyPath: basePath ? `${basePath}/COMPANY.md` : "COMPANY.md",
  };
}

export function validateCanonicalGithubImportSourceUrl(input: string): string {
  parseCanonicalGithubImportSourceUrl(input);
  return input;
}
