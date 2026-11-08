/**
 * Merge request rebase with completion polling.
 */
import { describe, expect, it, vi } from "vitest";

import { waitForRebase } from "../../src/tools/merge-request-rebase.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn(async (ms: number) => {
      current += ms;
    })
  };
}

describe("waitForRebase", () => {
  it("reports the new head once the rebase finishes", async () => {
    const getMergeRequest = vi
      .fn()
      .mockResolvedValueOnce({ sha: "old", rebase_in_progress: true })
      .mockResolvedValueOnce({ sha: "new", rebase_in_progress: false, merge_error: null });
    const context = buildContext({ gitlabStub: { getMergeRequest } });

    const result = await waitForRebase(context, "group/project", "7", "old", {
      timeoutMs: 60_000,
      ...fakeClock()
    });

    expect(result).toEqual({
      completed: true,
      rebase_in_progress: false,
      previous_sha: "old",
      sha: "new",
      head_changed: true,
      merge_error: null
    });
    expect(getMergeRequest).toHaveBeenCalledWith("group/project", "7", {
      query: { include_rebase_in_progress: true }
    });
  });

  it("re-checks an unchanged head before reporting it, since GitLab may not have started yet", async () => {
    const getMergeRequest = vi
      .fn()
      .mockResolvedValueOnce({ sha: "old", rebase_in_progress: false })
      .mockResolvedValueOnce({ sha: "old", rebase_in_progress: true })
      .mockResolvedValueOnce({ sha: "new", rebase_in_progress: false });
    const context = buildContext({ gitlabStub: { getMergeRequest } });

    const result = await waitForRebase(context, "p", "7", "old", {
      timeoutMs: 60_000,
      ...fakeClock()
    });

    expect(result).toMatchObject({ completed: true, head_changed: true, sha: "new" });
    expect(getMergeRequest).toHaveBeenCalledTimes(3);
  });

  it("settles on a merge error or an unchanged head after the re-checks", async () => {
    const failing = vi.fn().mockResolvedValue({
      sha: "old",
      rebase_in_progress: false,
      merge_error: "Rebase failed: conflicts"
    });
    const unchanged = vi.fn().mockResolvedValue({ sha: "old", rebase_in_progress: false });

    const failed = await waitForRebase(
      buildContext({ gitlabStub: { getMergeRequest: failing } }),
      "p",
      "7",
      "old",
      {
        timeoutMs: 60_000,
        ...fakeClock()
      }
    );
    const same = await waitForRebase(
      buildContext({ gitlabStub: { getMergeRequest: unchanged } }),
      "p",
      "7",
      "old",
      {
        timeoutMs: 60_000,
        ...fakeClock()
      }
    );

    expect(failed).toMatchObject({ completed: true, merge_error: "Rebase failed: conflicts" });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(same).toMatchObject({ completed: true, head_changed: false });
    expect(String(same.note)).toContain("did not change");
    expect(unchanged).toHaveBeenCalledTimes(4);
  });

  it("returns completed=false when GitLab is still rebasing at the deadline", async () => {
    const getMergeRequest = vi.fn().mockResolvedValue({ sha: "old", rebase_in_progress: true });

    const result = await waitForRebase(
      buildContext({ gitlabStub: { getMergeRequest } }),
      "p",
      "7",
      "old",
      { timeoutMs: 5_000, ...fakeClock() }
    );

    expect(result).toMatchObject({ completed: false, rebase_in_progress: true });
  });
});

describe("gitlab_rebase_merge_request", () => {
  it("records the previous head, requests the rebase, and can return without waiting", async () => {
    const getMergeRequest = vi.fn().mockResolvedValue({ iid: 7, sha: "abc" });
    const put = vi.fn().mockResolvedValue({ rebase_in_progress: true });

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { getMergeRequest, put } }),
        "gitlab_rebase_merge_request",
        { project_id: "group/project", merge_request_iid: 7, skip_ci: true, wait: false }
      )
    );

    expect(put).toHaveBeenCalledWith("/projects/group%2Fproject/merge_requests/7/rebase", {
      query: { skip_ci: true }
    });
    expect(result).toMatchObject({ rebase_in_progress: true, previous_sha: "abc" });
  });
});
