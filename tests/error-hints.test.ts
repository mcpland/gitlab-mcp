import { describe, expect, it, vi } from "vitest";

import { nextStepForGitLabStatus, nextStepForMessage } from "../src/lib/error-hints.js";
import { GitLabApiError } from "../src/lib/gitlab-client.js";
import { buildContext, callToolWithContext } from "./integration/_helpers.js";

describe("recovery hints", () => {
  it("maps GitLab statuses to a next step", () => {
    const local = { remoteCredentials: false };
    expect(nextStepForGitLabStatus(401, {}, local)).toContain("GITLAB_PERSONAL_ACCESS_TOKEN");
    expect(nextStepForGitLabStatus(401, {}, { remoteCredentials: true })).toContain(
      "Private-Token"
    );
    expect(nextStepForGitLabStatus(403, { error: "insufficient_scope" }, local)).toContain("scope");
    expect(nextStepForGitLabStatus(403, {}, local)).toContain("permission");
    expect(nextStepForGitLabStatus(404, {}, local)).toContain("project_id");
    expect(nextStepForGitLabStatus(429, {}, local)).toContain("retry_after_seconds");
    expect(nextStepForGitLabStatus(503, {}, local)).toContain("server error");
    expect(nextStepForGitLabStatus(204, {}, local)).toBeUndefined();
  });

  it("explains policy and project-scope refusals", () => {
    expect(nextStepForMessage("Tool 'gitlab_delete_issue' is disabled by policy")).toContain(
      "gitlab_discover_tools"
    );
    expect(
      nextStepForMessage("Project 'a/b' is not in GITLAB_ALLOWED_PROJECT_IDS: group/project")
    ).toContain("project_id");
    expect(nextStepForMessage("something else")).toBeUndefined();
  });
});

describe("tool error payloads", () => {
  it("add next_step to GitLab API errors in safe and full detail modes", async () => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("GitLab API request failed: 404", 404, {
        message: "404 Project Not Found"
      })
    );
    const context = buildContext({ gitlabStub: { getProject } });

    const full = await callToolWithContext(context, "gitlab_get_project", { project_id: "a/b" });
    context.env.GITLAB_ERROR_DETAIL_MODE = "safe";
    const safe = await callToolWithContext(context, "gitlab_get_project", { project_id: "a/b" });

    for (const result of [full, safe]) {
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(result.isError).toBe(true);
      expect(payload.next_step).toContain("project_id");
    }
  });

  it("append a Next line to project-scope refusals", async () => {
    const result = await callToolWithContext(
      buildContext({ allowedProjectIds: ["group/project"] }),
      "gitlab_get_project",
      { project_id: "other/project" }
    );
    const text = (result.content as Array<{ text: string }>)[0]!.text;

    expect(result.isError).toBe(true);
    expect(text).toContain("not in GITLAB_ALLOWED_PROJECT_IDS");
    expect(text).toContain("\nNext: ");
  });
});
