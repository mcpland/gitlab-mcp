import { describe, expect, it } from "vitest";

import { containsGraphqlMutation, shouldDisableGraphqlTools } from "../src/tools/gitlab.js";

describe("containsGraphqlMutation", () => {
  it("detects mutation operations", () => {
    expect(containsGraphqlMutation("mutation { createIssue(input: {}) { id } }")).toBeTruthy();
  });

  it("detects mutation operations not at the beginning of a document", () => {
    const document = `
      fragment SharedFields on Issue {
        id
      }

      mutation CreateIssue($title: String!) {
        createIssue(input: { title: $title }) {
          issue {
            ...SharedFields
          }
        }
      }
    `;

    expect(containsGraphqlMutation(document)).toBeTruthy();
  });

  it("does not flag query operations", () => {
    expect(containsGraphqlMutation('query { project(fullPath: "group/app") { id } }')).toBeFalsy();
  });

  it("ignores mutation keyword inside string literals", () => {
    const document =
      'query { search(query: "mutation { createIssue(input:{}) { id } }") { blobs { id } } }';
    expect(containsGraphqlMutation(document)).toBeFalsy();
  });
});

describe("shouldDisableGraphqlTools", () => {
  it("disables graphql tools by default when project scope restrictions are active", () => {
    expect(shouldDisableGraphqlTools(["123"], false)).toBeTruthy();
  });

  it("keeps graphql tools enabled when explicit override is set", () => {
    expect(shouldDisableGraphqlTools(["123"], true)).toBeFalsy();
  });

  it("keeps graphql tools enabled without project scope restrictions", () => {
    expect(shouldDisableGraphqlTools([], false)).toBeFalsy();
  });
});
