/**
 * GitLab Orbit knowledge-graph tools.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveToolScopeMetadata } from "../../src/tools/gitlab.js";
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

describe("GitLab Orbit tools", () => {
  it("stay hidden until enabled, since queries consume GitLab credits", async () => {
    expect(await listedToolNames({})).not.toContain("gitlab_orbit_query");
    expect(await listedToolNames({ enableOrbitTools: true })).toEqual(
      expect.arrayContaining([
        "gitlab_orbit_query",
        "gitlab_orbit_get_schema",
        "gitlab_orbit_get_status",
        "gitlab_orbit_list_tools"
      ])
    );
    expect(
      await listedToolNames({ enableOrbitTools: true, allowedProjectIds: ["group/project"] })
    ).not.toContain("gitlab_orbit_query");
    expect(resolveToolScopeMetadata("gitlab_orbit_query")).toMatchObject({
      kind: "global",
      projectScopedMode: "deny"
    });
  });

  it("posts graph queries with the llm format by default", async () => {
    const post = vi.fn().mockResolvedValue("project a -> merge_request 7");
    const context = buildContext({ gitlabStub: { post }, enableOrbitTools: true });
    const query = { match: { node: "Project", where: { name: "a" } } };

    const result = await callToolWithContext(context, "gitlab_orbit_query", { query });
    await callToolWithContext(context, "gitlab_orbit_query", { query, format: "raw" });

    expect(result.isError).toBeFalsy();
    expect(post.mock.calls.map(([path, options]) => [path, JSON.parse(options.body)])).toEqual([
      ["/orbit/query", { query, format: "llm" }],
      ["/orbit/query", { query, format: "raw" }]
    ]);
  });

  it("reads schema, status, and Orbit's own tool list", async () => {
    const get = vi.fn().mockResolvedValue({});
    const context = buildContext({ gitlabStub: { get }, enableOrbitTools: true });

    for (const name of [
      "gitlab_orbit_get_schema",
      "gitlab_orbit_get_status",
      "gitlab_orbit_list_tools"
    ]) {
      await callToolWithContext(context, name);
    }

    expect(get.mock.calls.map(([path]) => path)).toEqual([
      "/orbit/schema",
      "/orbit/status",
      "/orbit/tools"
    ]);
  });
});
