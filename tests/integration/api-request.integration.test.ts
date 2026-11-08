/**
 * Opt-in raw REST tool: gating, method policy, and path validation.
 */
import { describe, expect, it, vi } from "vitest";

import { normalizeApiPath } from "../../src/tools/api-request.js";
import { buildContext, callToolWithContext, createLinkedPair } from "./_helpers.js";

async function listedToolNames(options: Parameters<typeof buildContext>[0]): Promise<string[]> {
  const { client, clientTransport, serverTransport } = await createLinkedPair(
    buildContext(options)
  );
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
}

describe("normalizeApiPath", () => {
  it("accepts relative API paths, optionally prefixed with /api/v4", () => {
    expect(normalizeApiPath("/projects/group%2Fproject/repository/contributors")).toBe(
      "/projects/group%2Fproject/repository/contributors"
    );
    expect(normalizeApiPath("/api/v4/version")).toBe("/version");
  });

  it("rejects absolute URLs, queries, and dot segments", () => {
    for (const path of [
      "https://evil.example/api/v4/user",
      "//evil.example/x",
      "projects/1",
      "/projects/1?private_token=x",
      "/projects/1/../../user",
      "/projects/%2e%2e/user",
      "/projects/%252e%252e/user",
      "/projects//1",
      "/projects/1\\issues"
    ]) {
      expect(() => normalizeApiPath(path), path).toThrow();
    }
  });

  it("refuses credential, webhook, and GraphQL endpoints", () => {
    for (const path of [
      "/projects/1/variables",
      "/groups/2/variables/KEY",
      "/projects/1/triggers",
      "/personal_access_tokens",
      "/projects/1/access_tokens",
      "/projects/1/deploy_tokens",
      "/user/keys",
      "/runners/all",
      "/projects/1/hooks",
      "/application/settings",
      "/graphql",
      "/projects/1/VARIABLES"
    ]) {
      expect(() => normalizeApiPath(path), path).toThrow(
        "not available through gitlab_api_request"
      );
    }
  });
});

describe("gitlab_api_request", () => {
  it("is hidden unless GITLAB_ENABLE_RAW_API is on, and under a project allowlist", async () => {
    expect(await listedToolNames({})).not.toContain("gitlab_api_request");
    expect(await listedToolNames({ enableRawApi: true })).toContain("gitlab_api_request");
    expect(
      await listedToolNames({ enableRawApi: true, allowedProjectIds: ["group/project"] })
    ).not.toContain("gitlab_api_request");
  });

  it("sends GET requests with query parameters and advertises non-read-only annotations", async () => {
    const get = vi.fn().mockResolvedValue([{ name: "alice", commits: 3 }]);
    const context = buildContext({ gitlabStub: { get }, enableRawApi: true });

    const result = await callToolWithContext(context, "gitlab_api_request", {
      method: "GET",
      path: "/projects/42/repository/contributors",
      query: { order_by: "commits", sort: "desc", ids: [1, 2] }
    });

    expect(result.isError).toBeFalsy();
    expect(get).toHaveBeenCalledWith("/projects/42/repository/contributors", {
      query: { order_by: "commits", sort: "desc", ids: [1, 2] }
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(context);
    try {
      const tool = (await client.listTools()).tools.find(
        (item) => item.name === "gitlab_api_request"
      );
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("enforces the permission mode per HTTP method", async () => {
    const get = vi.fn().mockResolvedValue({});
    const post = vi.fn().mockResolvedValue({});
    const del = vi.fn().mockResolvedValue({});

    const readonly = buildContext({
      gitlabStub: { get, post },
      enableRawApi: true,
      permissionMode: "readonly"
    });
    expect(
      (
        await callToolWithContext(readonly, "gitlab_api_request", {
          method: "GET",
          path: "/version"
        })
      ).isError
    ).toBeFalsy();
    const readonlyPost = await callToolWithContext(readonly, "gitlab_api_request", {
      method: "POST",
      path: "/projects/1/issues",
      body: { title: "x" }
    });
    expect(readonlyPost.isError).toBe(true);
    expect(JSON.stringify(readonlyPost.content)).toContain("disabled by policy");

    const modify = buildContext({
      gitlabStub: { post, delete: del },
      enableRawApi: true,
      permissionMode: "modify"
    });
    expect(
      (
        await callToolWithContext(modify, "gitlab_api_request", {
          method: "POST",
          path: "/projects/1/issues",
          body: { title: "x" }
        })
      ).isError
    ).toBeFalsy();
    expect(
      (
        await callToolWithContext(modify, "gitlab_api_request", {
          method: "DELETE",
          path: "/projects/1/issues/2"
        })
      ).isError
    ).toBe(true);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/projects/1/issues", {
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
      query: {}
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("rejects request bodies on GET and DELETE", async () => {
    const get = vi.fn();

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { get }, enableRawApi: true }),
      "gitlab_api_request",
      { method: "GET", path: "/version", body: { a: 1 } }
    );

    expect(result.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
