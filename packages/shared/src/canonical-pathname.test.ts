import { describe, expect, it } from "vitest";
import {
  isCanonicalEncodedFragment,
  isCanonicalEncodedPathname,
  isCanonicalUrlSearch,
  rawFragmentFromHref,
  rawPathnameFromHref,
  rawSearchFromHref,
} from "./canonical-pathname.js";

describe("rawPathnameFromHref", () => {
  it.each([
    ["/tasks", "/tasks"],
    ["/tasks?view=all", "/tasks"],
    ["/tasks#comments", "/tasks"],
    ["/tasks?view=all#comments", "/tasks"],
    ["/u/auth0%7Cuser%40example.test", "/u/auth0%7Cuser%40example.test"],
  ])("extracts the raw pathname from %s", (href, pathname) => {
    expect(rawPathnameFromHref(href)).toBe(pathname);
  });
});

describe("rawFragmentFromHref", () => {
  it.each([
    ["/tasks", ""],
    ["/tasks?view=all", ""],
    ["/tasks#comment-1", "comment-1"],
    ["/tasks?view=all#document-plan", "document-plan"],
  ])("extracts the raw fragment from %s", (href, fragment) => {
    expect(rawFragmentFromHref(href)).toBe(fragment);
  });
});

describe("rawSearchFromHref", () => {
  it.each([
    ["/tasks", ""],
    ["/tasks?view=all", "?view=all"],
    ["/tasks#comments", ""],
    ["/tasks?view=all#comments", "?view=all"],
  ])("extracts the raw search string from %s", (href, search) => {
    expect(rawSearchFromHref(href)).toBe(search);
  });
});

describe("isCanonicalUrlSearch", () => {
  it.each([
    "",
    "?agentId=11111111-1111-4111-8111-111111111111",
    "?q=a+b",
    "?q=%7E",
    "?status=ready&status=paused",
  ])("accepts the canonical raw search string %s", (search) => {
    expect(isCanonicalUrlSearch(search)).toBe(true);
  });

  it.each([
    "?",
    "?agent%49d=11111111-1111-4111-8111-111111111111",
    "?agentId=%3111111111-1111-4111-8111-111111111111",
    "?q=a%20b",
    "?q=~",
    "?flag",
  ])("rejects the alias raw search string %s", (search) => {
    expect(isCanonicalUrlSearch(search)).toBe(false);
  });
});

describe("isCanonicalEncodedFragment", () => {
  it.each([
    "",
    "document-plan&thread=11111111-1111-4111-8111-111111111111",
    "label%20with%20spaces",
    "%E2%9C%93",
  ])("accepts the canonical raw fragment %s", (fragment) => {
    expect(isCanonicalEncodedFragment(fragment)).toBe(true);
  });

  it.each([
    "document-%70lan",
    "comment-%3111111111-1111-4111-8111-111111111111",
    "%7Ealias",
    "%ZZ",
    "%00",
  ])("rejects the alias or malformed raw fragment %s", (fragment) => {
    expect(isCanonicalEncodedFragment(fragment)).toBe(false);
  });
});

describe("isCanonicalEncodedPathname", () => {
  it.each([
    "/",
    "/api/tasks/11111111-1111-4111-8111-111111111111",
    "/11111111-1111-4111-8111-111111111111/u/auth0%7CBoard.User%40example.test",
    "/plugins/%E2%9C%93",
  ])("accepts the canonical raw pathname %s", (pathname) => {
    expect(isCanonicalEncodedPathname(pathname)).toBe(true);
  });

  it.each([
    "api/tasks",
    "/api//tasks",
    "/api/tasks/",
    "/api/%74asks",
    "/api/%7etasks",
    "/api/%2Ftasks",
    "/api/%5Ctasks",
    "/api/%7ctasks",
    "/api/|tasks",
    "/api/%ZZ",
    "/api/tasks?view=all",
  ])("rejects the alias or malformed pathname %s", (pathname) => {
    expect(isCanonicalEncodedPathname(pathname)).toBe(false);
  });
});
