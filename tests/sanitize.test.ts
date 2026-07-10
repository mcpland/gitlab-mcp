import { describe, expect, it } from "vitest";

import { sanitizeToolArguments } from "../src/lib/sanitize.js";

describe("sanitizeToolArguments", () => {
  it("removes only top-level null and undefined optional arguments", () => {
    const input = {
      title: "demo",
      description: null,
      omitted: undefined,
      zero: 0,
      enabled: false
    };

    expect(sanitizeToolArguments("gitlab_update_issue", input)).toEqual({
      title: "demo",
      zero: 0,
      enabled: false
    });
  });

  it("preserves null values in GraphQL variables", () => {
    const variables = {
      nullableInput: null,
      nested: { value: null },
      list: [1, null, 2]
    };

    expect(
      sanitizeToolArguments("gitlab_execute_graphql", {
        query: "query($value: String) { value(input: $value) }",
        variables
      })
    ).toEqual({
      query: "query($value: String) { value(input: $value) }",
      variables
    });
  });

  it("preserves null line numbers in merge-request positions", () => {
    const position = {
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      old_line: null,
      new_line: 12
    };

    expect(
      sanitizeToolArguments("gitlab_create_merge_request_thread", {
        body: "comment",
        position
      })
    ).toEqual({ body: "comment", position });
  });

  it.each(["gitlab_create_label", "gitlab_update_label"])(
    "preserves explicit priority=null for %s",
    (toolName) => {
      expect(sanitizeToolArguments(toolName, { name: "bug", priority: null })).toEqual({
        name: "bug",
        priority: null
      });
    }
  );

  it("does not preserve priority=null for unrelated tools", () => {
    expect(sanitizeToolArguments("gitlab_update_issue", { priority: null })).toEqual({});
  });
});
