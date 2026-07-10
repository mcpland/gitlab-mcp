import { describe, expect, it } from "vitest";

import {
  encodeGitLabGroupId,
  encodeGitLabNamespaceId,
  encodeGitLabProjectId,
  encodeGitLabSlashPath,
  isGitLabProjectIdentityAllowed
} from "../src/lib/gitlab-path.js";

describe("encodeGitLabProjectId", () => {
  it.each([
    ["group/project", "group%2Fproject"],
    ["group%2Fproject", "group%2Fproject"],
    ["group%252Fproject", "group%2Fproject"],
    ["12345", "12345"]
  ])("canonicalizes %s", (input, expected) => {
    expect(encodeGitLabProjectId(input)).toBe(expected);
    expect(encodeGitLabProjectId(encodeGitLabProjectId(input))).toBe(expected);
  });

  it.each([
    "group%2Gproject",
    "group%",
    "group/../secret",
    "group%2F%2e%2e%2Fsecret",
    "group%252F%252e%252e%252Fsecret",
    "/group/project",
    "group//project",
    "group\\project",
    "group/project?admin=true"
  ])("rejects unsafe project ID %s", (input) => {
    expect(() => encodeGitLabProjectId(input)).toThrow(/Invalid GitLab project ID/u);
  });
});

describe("isGitLabProjectIdentityAllowed", () => {
  it.each(["group/project", "group%2Fproject", "group%252Fproject"])(
    "matches canonical project path %s",
    (projectId) => {
      expect(isGitLabProjectIdentityAllowed(projectId, ["group/project"])).toBe(true);
    }
  );

  it("keeps numeric project identities exact after canonical decoding", () => {
    expect(isGitLabProjectIdentityAllowed("%31%32%33", ["123"])).toBe(true);
    expect(isGitLabProjectIdentityAllowed("0123", ["123"])).toBe(false);
  });
});

describe("encodeGitLabGroupId", () => {
  it.each([
    ["group/subgroup", "group%2Fsubgroup"],
    ["group%2Fsubgroup", "group%2Fsubgroup"],
    ["group%252Fsubgroup", "group%2Fsubgroup"],
    ["12345", "12345"]
  ])("canonicalizes %s", (input, expected) => {
    expect(encodeGitLabGroupId(input)).toBe(expected);
    expect(encodeGitLabGroupId(encodeGitLabGroupId(input))).toBe(expected);
  });

  it.each(["group%2Gsubgroup", "group/../secret", "/group", "group//subgroup"])(
    "rejects unsafe group ID %s",
    (input) => {
      expect(() => encodeGitLabGroupId(input)).toThrow(/Invalid GitLab group ID/u);
    }
  );
});

describe("encodeGitLabNamespaceId", () => {
  it.each([
    ["group/subgroup", "group%2Fsubgroup"],
    ["group%2Fsubgroup", "group%2Fsubgroup"],
    ["group%252Fsubgroup", "group%2Fsubgroup"],
    ["12345", "12345"]
  ])("canonicalizes %s", (input, expected) => {
    expect(encodeGitLabNamespaceId(input)).toBe(expected);
  });

  it("rejects traversal paths", () => {
    expect(() => encodeGitLabNamespaceId("group/../secret")).toThrow(
      /Invalid GitLab namespace ID/u
    );
  });
});

describe("encodeGitLabSlashPath", () => {
  it.each([
    ["reports/summary.txt", "reports/summary.txt"],
    ["bin/my app.tar.gz", "bin/my%20app.tar.gz"],
    ["bin/my%20app.tar.gz", "bin/my%20app.tar.gz"]
  ])("canonicalizes safe nested path %s", (input, expected) => {
    expect(encodeGitLabSlashPath(input, "artifact_path")).toBe(expected);
  });

  it("normalizes one explicitly allowed leading slash", () => {
    expect(
      encodeGitLabSlashPath("/binaries/app", "direct_asset_path", {
        allowSingleLeadingSlash: true
      })
    ).toBe("binaries/app");
  });

  it.each(["/../secret", "//evil"])("still rejects unsafe leading-slash path %s", (input) => {
    expect(() =>
      encodeGitLabSlashPath(input, "direct_asset_path", {
        allowSingleLeadingSlash: true
      })
    ).toThrow(/Invalid GitLab direct_asset_path/u);
  });

  it.each([
    "",
    ".",
    "..",
    "/secret",
    "secret/",
    "a//b",
    "a/../b",
    "a\\..\\b",
    "%2e%2e/secret",
    "%252e%252e/secret",
    "%2fsecret",
    "%252fsecret",
    "%5csecret",
    "%255csecret",
    "%00secret",
    "\u0000secret"
  ])("rejects unsafe nested path %s", (input) => {
    expect(() => encodeGitLabSlashPath(input, "artifact_path")).toThrow(
      /Invalid GitLab artifact_path/u
    );
  });
});
