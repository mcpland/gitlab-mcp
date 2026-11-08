/**
 * In-place protected branch updates.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../../src/lib/gitlab-client.js";
import { buildContext, callToolWithContext } from "./_helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const currentRule = {
  name: "main",
  unprotect_access_levels: [
    { id: 11, access_level: 40 },
    { id: 12, user_id: 5 }
  ]
};

describe("gitlab_update_protected_branch", () => {
  it("patches settings and access entries without reading when unprotect is untouched", async () => {
    const getProtectedBranch = vi.fn();
    const updateProtectedBranch = vi.fn().mockResolvedValue({ name: "main" });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { getProtectedBranch, updateProtectedBranch } }),
      "gitlab_update_protected_branch",
      {
        project_id: "group/project",
        branch: "main",
        allow_force_push: false,
        allowed_to_push: [{ access_level: 40 }, { id: 3, _destroy: true }, { deploy_key_id: 9 }]
      }
    );

    expect(result.isError).toBeFalsy();
    expect(getProtectedBranch).not.toHaveBeenCalled();
    expect(updateProtectedBranch).toHaveBeenCalledWith("group/project", "main", {
      allow_force_push: false,
      allowed_to_push: [{ access_level: 40 }, { id: 3, _destroy: true }, { deploy_key_id: 9 }]
    });
  });

  it("allows replacing unprotect entries but refuses removing them all", async () => {
    const getProtectedBranch = vi.fn().mockResolvedValue(currentRule);
    const updateProtectedBranch = vi.fn().mockResolvedValue({ name: "main" });
    const context = buildContext({ gitlabStub: { getProtectedBranch, updateProtectedBranch } });

    const replaced = await callToolWithContext(context, "gitlab_update_protected_branch", {
      project_id: "group/project",
      branch: "main",
      allowed_to_unprotect: [
        { id: 11, _destroy: true },
        { id: 12, _destroy: true },
        { access_level: 60 }
      ]
    });
    const lockedOut = await callToolWithContext(context, "gitlab_update_protected_branch", {
      project_id: "group/project",
      branch: "main",
      allowed_to_unprotect: [
        { id: 11, _destroy: true },
        { id: 12, _destroy: true }
      ]
    });

    expect(replaced.isError).toBeFalsy();
    expect(lockedOut.isError).toBe(true);
    expect(JSON.stringify(lockedOut.content)).toContain(
      "Refusing to remove every allowed_to_unprotect"
    );
    expect(updateProtectedBranch).toHaveBeenCalledTimes(1);
  });

  it("validates entry shapes before calling GitLab", async () => {
    const updateProtectedBranch = vi.fn();
    const context = buildContext({ gitlabStub: { updateProtectedBranch } });

    for (const args of [
      {},
      { allowed_to_merge: [{ _destroy: true }] },
      { allowed_to_merge: [{ user_id: 1, group_id: 2 }] },
      { allowed_to_merge: [{ deploy_key_id: 9 }] },
      { allowed_to_push: [{ access_level: 20 }] }
    ]) {
      const result = await callToolWithContext(context, "gitlab_update_protected_branch", {
        project_id: "group/project",
        branch: "main",
        ...args
      });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(updateProtectedBranch).not.toHaveBeenCalled();
  });

  it("sends a PATCH request to the protected branch endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new GitLabClient("https://gitlab.example.com", "token").updateProtectedBranch(
      "group/project",
      "release/*",
      { allow_force_push: true }
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(new URL(String(url)).pathname).toBe(
      "/api/v4/projects/group%2Fproject/protected_branches/release%2F*"
    );
    expect(JSON.parse(String(init.body))).toEqual({ allow_force_push: true });
  });
});
