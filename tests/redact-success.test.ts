import { describe, expect, it } from "vitest";

import { redactSuccessfulResponse } from "../src/lib/redact-success.js";

describe("redactSuccessfulResponse", () => {
  it("removes project credential-bearing fields recursively without mutating input", () => {
    const input = {
      id: 1,
      runners_token: "runner-secret",
      import_url: "https://user:password@gitlab.example.com/group/project.git",
      nested: {
        runners_token: "nested-secret",
        name: "kept"
      }
    };

    expect(redactSuccessfulResponse(input)).toEqual({
      id: 1,
      nested: { name: "kept" }
    });
    expect(input.runners_token).toBe("runner-secret");
  });

  it("preserves legitimate CI and credential-management response fields", () => {
    const input = {
      key: "DEPLOY_TOKEN",
      value: "tool-requested-secret-value",
      masked: true,
      protected: true,
      token_name: "release-token",
      ci_job_token_scope_enabled: true
    };

    expect(redactSuccessfulResponse(input)).toEqual(input);
  });

  it("redacts fields inside arrays while preserving scalar values", () => {
    expect(
      redactSuccessfulResponse([{ id: 1, runners_token: "secret" }, null, "unchanged"])
    ).toEqual([{ id: 1 }, null, "unchanged"]);
  });
});
