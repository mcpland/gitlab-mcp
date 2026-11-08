/**
 * health_check liveness and optional GitLab connectivity report.
 */
import { describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../../src/lib/gitlab-client.js";
import { buildContext, callToolWithContext } from "./_helpers.js";

type Structured = Record<string, unknown> & { gitlab?: Record<string, unknown> };

function structured(result: Awaited<ReturnType<typeof callToolWithContext>>): Structured {
  return (result as { structuredContent?: Structured }).structuredContent ?? {};
}

describe("health_check", () => {
  it("reports liveness and the server identity without contacting GitLab", async () => {
    const whoami = vi.fn();

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { whoami }, serverName: "my-gitlab" }),
      "health_check"
    );

    expect(structured(result)).toMatchObject({
      status: "ok",
      server: { name: "my-gitlab", version: "0.0.1" }
    });
    expect(whoami).not.toHaveBeenCalled();
  });

  it("checks authentication and the GitLab version on request", async () => {
    const whoami = vi.fn().mockResolvedValue({ id: 7, username: "alice", email: "a@x" });
    const get = vi.fn().mockResolvedValue({ version: "19.5.1-ee", revision: "abc123" });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { whoami, get } }),
      "health_check",
      { check_gitlab: true }
    );

    expect(structured(result)).toMatchObject({
      status: "ok",
      gitlab: {
        api_url: "https://gitlab.example.com/api/v4",
        reachable: true,
        authenticated: true,
        user: { id: 7, username: "alice" },
        version: "19.5.1-ee",
        revision: "abc123"
      }
    });
    expect(JSON.stringify(result)).not.toContain("a@x");
    expect(get).toHaveBeenCalledWith("/version");
  });

  it("reports unreachable GitLab with the transport reason instead of failing", async () => {
    const whoami = vi.fn().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND gitlab.example.com" }
      })
    );

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { whoami } }),
      "health_check",
      { check_gitlab: "true" }
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      status: "error",
      gitlab: { reachable: false, authenticated: false, error: { kind: "dns", code: "ENOTFOUND" } }
    });
  });

  it("treats an insufficient-scope 403 as authenticated with a warning", async () => {
    const whoami = vi
      .fn()
      .mockRejectedValue(new GitLabApiError("forbidden", 403, { error: "insufficient_scope" }));
    const get = vi.fn().mockRejectedValue(new GitLabApiError("forbidden", 403, {}));

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { whoami, get } }),
      "health_check",
      { check_gitlab: true }
    );

    expect(structured(result)).toMatchObject({
      status: "degraded",
      gitlab: { reachable: true, authenticated: true }
    });
    expect(String(structured(result).gitlab?.warning)).toContain("read_user");
  });

  it("reports a rejected credential as degraded", async () => {
    const whoami = vi
      .fn()
      .mockRejectedValue(new GitLabApiError("GitLab API request failed: 401", 401, {}));

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { whoami } }),
      "health_check",
      { check_gitlab: true }
    );

    expect(structured(result)).toMatchObject({
      status: "degraded",
      gitlab: { reachable: true, authenticated: false, error: { kind: "http", code: "401" } }
    });
  });
});
