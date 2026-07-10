import { describe, expect, it } from "vitest";

import {
  assertGraphqlDocumentAllowedByPermissionMode,
  containsGraphqlMutation,
  resolveToolScopeMetadata
} from "../src/tools/gitlab.js";

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

  it("detects mutation operations with directives", () => {
    expect(containsGraphqlMutation("mutation @client { createIssue(input: {}) { id } }")).toBe(
      true
    );
    expect(
      containsGraphqlMutation(
        "mutation CreateIssue($input: CreateIssueInput!) @client { createIssue(input: $input) { id } }"
      )
    ).toBe(true);
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

  it("does not flag query fields named mutation", () => {
    expect(containsGraphqlMutation("query { mutation { id } }")).toBeFalsy();
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

describe("modify-mode raw GraphQL guard", () => {
  it("allows non-destructive top-level mutation fields", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        'mutation { updateProject(input: { description: "delete/destroy/remove" }) { project { id } } }',
        "modify"
      )
    ).not.toThrow();
  });

  it("blocks destructive field names while ignoring a safe field's alias", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        "mutation { keepProject: deleteProject(input: {}) { errors } }",
        "modify"
      )
    ).toThrow("deleteProject");

    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        "mutation { deleteProject: createProject(input: {}) { errors } }",
        "modify"
      )
    ).not.toThrow();
  });

  it("checks fields exposed through inline fragments and fragment spreads", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        "mutation { ... on Mutation { purgeCaches(input: {}) { errors } } }",
        "modify"
      )
    ).toThrow("purgeCaches");

    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        `mutation { ...DestructiveMutation }
         fragment DestructiveMutation on Mutation {
           removeMember(input: {}) { errors }
         }`,
        "modify"
      )
    ).toThrow("removeMember");
  });

  it("does not inspect response fields below the mutation root", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        "mutation { updateProject(input: {}) { project { deleteProtectionRule } } }",
        "modify"
      )
    ).not.toThrow();
  });

  it("fails closed when a document or referenced fragment cannot be verified", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode("mutation { updateProject(", "modify")
    ).toThrow("could not be verified safely");
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        "mutation { ...MissingMutationFields }",
        "modify"
      )
    ).toThrow("could not be verified safely");
  });

  it("fails closed for a referenced fragment cycle", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        `mutation { ...FirstMutationFields }
         fragment FirstMutationFields on Mutation { ...SecondMutationFields }
         fragment SecondMutationFields on Mutation { ...FirstMutationFields }`,
        "modify"
      )
    ).toThrow("could not be verified safely");
  });

  it("ignores destructive fields in fragments that no mutation references", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        `mutation { updateProject(input: {}) { errors } }
         fragment UnusedMutationFields on Mutation {
           deleteProject(input: {}) { errors }
         }`,
        "modify"
      )
    ).not.toThrow();
  });

  it("does not apply the destructive-name guard in full mode", () => {
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode(
        "mutation { destroyProject(input: {}) { errors } }",
        "full"
      )
    ).not.toThrow();
    expect(() =>
      assertGraphqlDocumentAllowedByPermissionMode("mutation { destroyProject(", "full")
    ).not.toThrow();
  });
});

describe("resolveToolScopeMetadata", () => {
  it("classifies raw GraphQL as unsafe in project-scoped mode", () => {
    expect(resolveToolScopeMetadata("gitlab_execute_graphql_query")).toEqual({
      kind: "rawGraphQL",
      projectScopedMode: "deny"
    });
  });

  it("classifies group tools separately from project tools", () => {
    expect(resolveToolScopeMetadata("gitlab_list_group_wiki_pages")).toMatchObject({
      kind: "group",
      groupIdArguments: ["group_id"],
      projectScopedMode: "deny"
    });
    expect(resolveToolScopeMetadata("gitlab_create_group")).toMatchObject({
      kind: "group",
      groupIdArguments: [],
      projectScopedMode: "deny"
    });
  });

  it("declares source and target project arguments", () => {
    expect(resolveToolScopeMetadata("gitlab_create_merge_request")).toMatchObject({
      kind: "project",
      projectIdArguments: ["project_id", "target_project_id"]
    });
  });

  it("classifies project-bound CI lint as a project tool", () => {
    expect(resolveToolScopeMetadata("gitlab_validate_ci_lint")).toMatchObject({
      kind: "project",
      projectIdArguments: ["project_id"],
      projectScopedMode: "allow"
    });
  });

  it("marks filterable global tools without allowing unsafe global tools", () => {
    expect(resolveToolScopeMetadata("gitlab_list_projects")).toMatchObject({
      kind: "global",
      projectScopedMode: "filter"
    });
    expect(resolveToolScopeMetadata("gitlab_list_events")).toMatchObject({
      kind: "global",
      projectScopedMode: "deny"
    });
  });
});
