/**
 * Job control tools forward run-time options to GitLab.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../../src/lib/gitlab-client.js";
import { buildContext, callToolWithContext } from "./_helpers.js";

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("job control client requests", () => {
  it("sends play variables and inputs as JSON, and force as a cancel query", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async () => jsonResponse({ id: 9 }));
    const client = new GitLabClient("https://gitlab.example.com", "token");

    await client.playPipelineJob("group/project", "9", {
      job_variables_attributes: [{ key: "DEPLOY_ENV", value: "staging" }],
      job_inputs: { replicas: 2 }
    });
    await client.retryPipelineJob("group/project", "9", { job_inputs: { dry_run: true } });
    await client.cancelPipelineJob("group/project", "9", { force: true });
    await client.playPipelineJob("group/project", "9");

    const calls = fetchMock.mock.calls as Array<[URL | string, RequestInit]>;
    expect(new URL(String(calls[0]![0])).pathname).toBe(
      "/api/v4/projects/group%2Fproject/jobs/9/play"
    );
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      job_variables_attributes: [{ key: "DEPLOY_ENV", value: "staging" }],
      job_inputs: { replicas: 2 }
    });
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ job_inputs: { dry_run: true } });
    const cancelUrl = new URL(String(calls[2]![0]));
    expect(cancelUrl.pathname).toBe("/api/v4/projects/group%2Fproject/jobs/9/cancel");
    expect(cancelUrl.searchParams.get("force")).toBe("true");
    expect(calls[3]![1].body).toBeUndefined();
  });
});

describe("job control tools", () => {
  it("passes play variables and inputs from the tool call", async () => {
    const playPipelineJob = vi.fn().mockResolvedValue({ id: 9, status: "pending" });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { playPipelineJob } }),
      "gitlab_play_pipeline_job",
      {
        project_id: "group/project",
        job_id: "9",
        job_variables_attributes: [{ key: "DEPLOY_ENV", value: "staging" }],
        job_inputs: { replicas: 2 }
      }
    );

    expect(result.isError).toBeFalsy();
    expect(playPipelineJob).toHaveBeenCalledWith("group/project", "9", {
      job_variables_attributes: [{ key: "DEPLOY_ENV", value: "staging" }],
      job_inputs: { replicas: 2 }
    });
  });

  it("rejects invalid variable keys before calling GitLab", async () => {
    const playPipelineJob = vi.fn();

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { playPipelineJob } }),
      "gitlab_play_pipeline_job",
      {
        project_id: "group/project",
        job_id: "9",
        job_variables_attributes: [{ key: "BAD KEY", value: "x" }]
      }
    );

    expect(result.isError).toBe(true);
    expect(playPipelineJob).not.toHaveBeenCalled();
  });

  it("forwards force cancellation and retry inputs", async () => {
    const cancelPipelineJob = vi.fn().mockResolvedValue({ id: 9 });
    const retryPipelineJob = vi.fn().mockResolvedValue({ id: 10 });
    const context = buildContext({ gitlabStub: { cancelPipelineJob, retryPipelineJob } });

    await callToolWithContext(context, "gitlab_cancel_pipeline_job", {
      project_id: "group/project",
      job_id: "9",
      force: "true"
    });
    await callToolWithContext(context, "gitlab_retry_pipeline_job", {
      project_id: "group/project",
      job_id: "9",
      job_inputs: { dry_run: false }
    });

    expect(cancelPipelineJob).toHaveBeenCalledWith("group/project", "9", { force: true });
    expect(retryPipelineJob).toHaveBeenCalledWith("group/project", "9", {
      job_inputs: { dry_run: false }
    });
  });
});
