import { describe, expect, it } from "vitest";

import { containsGraphqlMutation, shouldDisableGraphqlTools } from "../src/tools/gitlab.js";

describe("containsGraphqlMutation", () => {
  it("detects mutation operations", () => {
    expect(containsGraphqlMutation("mutation { createIssue(input: {}) { id } }")).toBeTruthy();
  });

  it("detects named mutation operations", () => {
    expect(
      containsGraphqlMutation("mutation CreateIssue { createIssue(input: {}) { id } }")
    ).toBeTruthy();
  });

  it("detects mutation with variables", () => {
    expect(
      containsGraphqlMutation(
        "mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { id } }"
      )
    ).toBeTruthy();
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

  it("does not flag named query operations", () => {
    expect(
      containsGraphqlMutation('query GetProject { project(fullPath: "group/app") { id } }')
    ).toBeFalsy();
  });

  it("ignores mutation keyword inside string literals", () => {
    const document =
      'query { search(query: "mutation { createIssue(input:{}) { id } }") { blobs { id } } }';
    expect(containsGraphqlMutation(document)).toBeFalsy();
  });

  it("ignores mutation keyword inside triple-quoted strings", () => {
    const document = `query {
      search(query: """mutation { createIssue(input:{}) { id } }""") {
        blobs { id }
      }
    }`;
    expect(containsGraphqlMutation(document)).toBeFalsy();
  });

  it("ignores mutation keyword in comments", () => {
    const document = `
      # mutation CreateIssue { ... }
      query { project { id } }
    `;
    expect(containsGraphqlMutation(document)).toBeFalsy();
  });

  it("returns false for empty string", () => {
    expect(containsGraphqlMutation("")).toBeFalsy();
  });

  it("returns false for whitespace only", () => {
    expect(containsGraphqlMutation("   \n  ")).toBeFalsy();
  });

  it("detects case-insensitive mutation keyword", () => {
    expect(containsGraphqlMutation("MUTATION { createIssue { id } }")).toBeTruthy();
    expect(containsGraphqlMutation("Mutation { createIssue { id } }")).toBeTruthy();
  });

  it("handles subscription operations (not mutation)", () => {
    expect(containsGraphqlMutation("subscription { issueUpdated { id status } }")).toBeFalsy();
  });

  it("detects mutation with leading whitespace/newlines", () => {
    expect(containsGraphqlMutation("\n\n  mutation { deleteIssue { id } }")).toBeTruthy();
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

  it("keeps graphql tools enabled with empty project IDs and override", () => {
    expect(shouldDisableGraphqlTools([], true)).toBeFalsy();
  });

  it("disables with multiple project IDs", () => {
    expect(shouldDisableGraphqlTools(["1", "2", "3"], false)).toBeTruthy();
  });

  it("enables with multiple project IDs and override", () => {
    expect(shouldDisableGraphqlTools(["1", "2", "3"], true)).toBeFalsy();
  });
});
