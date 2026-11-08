import { describe, expect, it, vi } from "vitest";

import { GitLabApiError, GitLabClient } from "../src/lib/gitlab-client.js";
import { classifyTransportFailure, describeTransportFailure } from "../src/lib/transport-error.js";
import { buildContext, createLinkedPair } from "./integration/_helpers.js";

function fetchFailed(cause: Record<string, unknown>): TypeError {
  return new TypeError("fetch failed", { cause });
}

describe("classifyTransportFailure", () => {
  it("reads the OS reason that undici keeps on error.cause", () => {
    const failure = classifyTransportFailure(
      fetchFailed({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 10.0.0.5:443" })
    );

    expect(failure).toMatchObject({
      kind: "network",
      code: "ECONNREFUSED",
      message: "fetch failed: connect ECONNREFUSED 10.0.0.5:443"
    });
    expect(describeTransportFailure(failure!)).toBe(
      "GitLab request failed before an HTTP response (ECONNREFUSED): fetch failed: connect ECONNREFUSED 10.0.0.5:443. Check GITLAB_API_URL, that GitLab is reachable from this host, and the proxy settings."
    );
  });

  it("classifies DNS, TLS, and timeout failures", () => {
    expect(
      classifyTransportFailure(
        fetchFailed({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND gitlab.invalid" })
      )?.kind
    ).toBe("dns");
    expect(
      classifyTransportFailure(
        fetchFailed({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "unable to verify" })
      )
    ).toMatchObject({ kind: "tls", hint: expect.stringContaining("GITLAB_CA_CERT_PATH") });
    expect(
      classifyTransportFailure(new DOMException("The operation timed out.", "TimeoutError"))
    ).toMatchObject({ kind: "timeout", hint: expect.stringContaining("GITLAB_HTTP_TIMEOUT_MS") });
  });

  it("ignores errors that are not transport failures", () => {
    expect(classifyTransportFailure(new Error("fetch failed"))).toBeUndefined();
    expect(classifyTransportFailure(new TypeError("bad input"))).toBeUndefined();
    expect(classifyTransportFailure(new GitLabApiError("boom", 500))).toBeUndefined();
    expect(classifyTransportFailure("fetch failed")).toBeUndefined();
  });
});

describe("GitLab API error retry metadata", () => {
  it("records Retry-After seconds on rate-limited responses", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "429 Too Many Requests" }), {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "content-type": "application/json", "retry-after": "17" }
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxGetRetries: 0
      });
      const error = await client.getProject("1").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GitLabApiError);
      expect((error as GitLabApiError).status).toBe(429);
      expect((error as GitLabApiError).retryAfterSeconds).toBe(17);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("tool errors", () => {
  it("names the transport reason when GitLab cannot be reached", async () => {
    const getProject = vi
      .fn()
      .mockRejectedValue(
        fetchFailed({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 10.0.0.5:443" })
      );
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";

      expect(result.isError).toBe(true);
      expect(text).toContain("before an HTTP response (ECONNREFUSED)");
      expect(text).toContain("connect ECONNREFUSED 10.0.0.5:443");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("reports retry_after_seconds for rate-limited GitLab responses", async () => {
    const getProject = vi
      .fn()
      .mockRejectedValue(
        new GitLabApiError(
          "GitLab API request failed: 429 Too Many Requests",
          429,
          { message: "429 Too Many Requests" },
          { retryAfterSeconds: 30 }
        )
      );
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");

      expect(result.isError).toBe(true);
      expect(payload).toMatchObject({ error: "GitLab API error 429", retry_after_seconds: 30 });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
