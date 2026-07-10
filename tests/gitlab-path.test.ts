import { describe, expect, it } from "vitest";

import { encodeGitLabProjectId } from "../src/lib/gitlab-path.js";

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
