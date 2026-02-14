/**
 * Integration tests for error handling.
 *
 * Tests `toToolError()` and `redactSensitive()` end-to-end via
 * `createLinkedPair` with stubs that throw `GitLabApiError` or generic `Error`.
 */
import { describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../../src/lib/gitlab-client.js";
import { buildContext, createLinkedPair } from "./_helpers.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getErrorText(result: { content?: Array<{ type: string; text: string }> }): string {
  const textContent = result.content?.find((c) => c.type === "text");
  return textContent?.text ?? "";
}

/* ------------------------------------------------------------------ */
/*  GitLabApiError handling                                            */
/* ------------------------------------------------------------------ */

describe("Error handling: GitLabApiError", () => {
  it("404 error returns isError with 'GitLab API error 404'", async () => {
    const getProject = vi.fn().mockRejectedValue(new GitLabApiError("Not Found", 404));

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "missing/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("GitLab API error 404");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("500 error returns isError with 'GitLab API error 500'", async () => {
    const getProject = vi.fn().mockRejectedValue(new GitLabApiError("Server Error", 500));

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("GitLab API error 500");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Generic Error handling                                             */
/* ------------------------------------------------------------------ */

describe("Error handling: Generic Error", () => {
  it("generic Error returns isError with message in full mode", async () => {
    const getProject = vi.fn().mockRejectedValue(new Error("Something went wrong"));

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("Something went wrong");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("error detail 'safe' mode returns 'Request failed' for generic Error", async () => {
    const getProject = vi.fn().mockRejectedValue(new Error("Sensitive internal info"));

    const ctx = buildContext({ gitlabStub: { getProject } });
    (ctx.env as { GITLAB_ERROR_DETAIL_MODE: string }).GITLAB_ERROR_DETAIL_MODE = "safe";

    const { client, clientTransport, serverTransport } = await createLinkedPair(ctx);

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toBe("Request failed");
      expect(text).not.toContain("Sensitive internal info");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("error detail 'safe' mode omits GitLabApiError details", async () => {
    const getProject = vi
      .fn()
      .mockRejectedValue(
        new GitLabApiError("Forbidden", 403, { message: "Token expired", scope: "api" })
      );

    const ctx = buildContext({ gitlabStub: { getProject } });
    (ctx.env as { GITLAB_ERROR_DETAIL_MODE: string }).GITLAB_ERROR_DETAIL_MODE = "safe";

    const { client, clientTransport, serverTransport } = await createLinkedPair(ctx);

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("GitLab API error 403");
      expect(text).not.toContain("Token expired");
      expect(text).not.toContain("scope");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Unknown error (non-Error throw)                                    */
/* ------------------------------------------------------------------ */

describe("Error handling: Unknown error", () => {
  it("non-Error throw returns 'Unknown error'", async () => {
    const getProject = vi.fn().mockRejectedValue("string error");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toBe("Unknown error");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Token/sensitive redaction in error details (full mode)              */
/* ------------------------------------------------------------------ */

describe("Error handling: Token redaction", () => {
  it("redacts glpat-xxx tokens in error details", async () => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("Unauthorized", 401, {
        message: "Token glpat-abcdef1234567890 is invalid"
      })
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("glpat-abcdef1234567890");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("redacts ghp_xxx tokens in error details", async () => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("Unauthorized", 401, {
        message: "Token ghp_abcdef1234567890abcde is invalid"
      })
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("ghp_abcdef1234567890abcde");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("redacts JWT eyJ tokens in error details", async () => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("Unauthorized", 401, {
        message: "Token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload is invalid"
      })
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("redacts sensitive object keys (authorization, password, token, secret)", async () => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("Error", 400, {
        authorization: "Bearer secret-val",
        password: "hunter2",
        token: "abc123",
        secret: "my-secret",
        message: "safe value",
        status: 400
      })
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      // Sensitive keys should be redacted
      expect(text).not.toContain("secret-val");
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("abc123");
      expect(text).not.toContain("my-secret");
      // Safe keys should be preserved
      expect(text).toContain("safe value");
      expect(text).toContain("400");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("redacts authorization header patterns in strings", async () => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("Error", 400, {
        message: "Request with private_token=glpat-abcdef1234567890 failed"
      })
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/project" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).not.toContain("glpat-abcdef1234567890");
      expect(text).toContain("[REDACTED]");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
