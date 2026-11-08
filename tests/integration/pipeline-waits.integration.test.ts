/**
 * Waiting on pipelines and jobs, and erasing job output.
 */
import { describe, expect, it, vi } from "vitest";

import { waitForTerminalStatus, TERMINAL_JOB_STATUSES } from "../../src/tools/pipeline-jobs.js";
import { buildContext, callToolWithContext, createLinkedPair, parseToolText } from "./_helpers.js";

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn(async (ms: number) => {
      current += ms;
    })
  };
}

describe("waitForTerminalStatus", () => {
  it("polls until a terminal status and reports the wait", async () => {
    const clock = fakeClock();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "failed", id: 9 });

    const outcome = await waitForTerminalStatus({
      fetch,
      terminalStatuses: TERMINAL_JOB_STATUSES,
      timeoutMs: 60_000,
      intervalMs: 5_000,
      ...clock
    });

    expect(outcome.value).toEqual({ status: "failed", id: 9 });
    expect(outcome.summary).toEqual({
      completed: true,
      status: "failed",
      polls: 3,
      waited_seconds: 10
    });
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("returns the last status instead of failing when the deadline passes", async () => {
    const clock = fakeClock();
    const fetch = vi.fn().mockResolvedValue({ status: "running" });

    const outcome = await waitForTerminalStatus({
      fetch,
      terminalStatuses: TERMINAL_JOB_STATUSES,
      timeoutMs: 12_000,
      intervalMs: 5_000,
      ...clock
    });

    expect(outcome.summary).toMatchObject({ completed: false, status: "running", polls: 4 });
    expect(outcome.summary.note).toContain("call again");
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 5_000, 2_000]);
  });

  it("stops polling when the client cancels", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(async () => {
      controller.abort(new Error("client cancelled"));
      return { status: "running" };
    });

    await expect(
      waitForTerminalStatus({
        fetch,
        terminalStatuses: TERMINAL_JOB_STATUSES,
        timeoutMs: 60_000,
        intervalMs: 1_000,
        signal: controller.signal
      })
    ).rejects.toThrow("client cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("wait and erase tools", () => {
  it("returns immediately for a pipeline that already finished", async () => {
    const getPipeline = vi.fn().mockResolvedValue({ id: 7, status: "success" });

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { getPipeline } }),
        "gitlab_wait_for_pipeline",
        {
          project_id: "group/project",
          pipeline_id: 7
        }
      )
    );

    expect(getPipeline).toHaveBeenCalledWith("group/project", "7");
    expect(result).toMatchObject({
      completed: true,
      status: "success",
      polls: 1,
      pipeline: { id: 7, status: "success" }
    });
  });

  it("waits for a job and rejects out-of-range timeouts", async () => {
    const getPipelineJob = vi.fn().mockResolvedValue({ id: 3, status: "manual" });
    const context = buildContext({ gitlabStub: { getPipelineJob } });

    const result = parseToolText(
      await callToolWithContext(context, "gitlab_wait_for_job", {
        project_id: "group/project",
        job_id: "3",
        timeout_seconds: 30
      })
    );
    const invalid = await callToolWithContext(context, "gitlab_wait_for_job", {
      project_id: "group/project",
      job_id: "3",
      timeout_seconds: 3_600
    });

    expect(result).toMatchObject({ completed: true, status: "manual", job: { id: 3 } });
    expect(invalid.isError).toBe(true);
  });

  it("erases job output through the delete capability", async () => {
    const post = vi.fn().mockResolvedValue({ id: 3, erased_at: "2026-11-07T00:00:00Z" });

    await callToolWithContext(buildContext({ gitlabStub: { post } }), "gitlab_erase_pipeline_job", {
      project_id: "group/project",
      job_id: "3"
    });
    expect(post).toHaveBeenCalledWith("/projects/group%2Fproject/jobs/3/erase");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ permissionMode: "modify" })
    );
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_wait_for_job");
      expect(names).not.toContain("gitlab_erase_pipeline_job");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
