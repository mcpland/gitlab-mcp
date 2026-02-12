import { describe, expect, it } from "vitest";

import { containsGraphqlMutation } from "../src/tools/gitlab.js";

describe("containsGraphqlMutation", () => {
  it("detects mutation operations", () => {
    expect(containsGraphqlMutation("mutation { createIssue(input: {}) { id } }")).toBeTruthy();
  });

  it("does not flag query operations", () => {
    expect(containsGraphqlMutation('query { project(fullPath: "group/app") { id } }')).toBeFalsy();
  });
});
