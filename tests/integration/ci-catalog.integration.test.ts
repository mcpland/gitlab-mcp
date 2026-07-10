import { describe, expect, it, vi } from "vitest";

import { buildContext, createLinkedPair } from "./_helpers.js";

const CI_CATALOG_TOOLS = ["gitlab_list_ci_catalog_resources", "gitlab_get_ci_catalog_resource"];

function textOf(result: { content?: Array<{ type: string; text: string }> }): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("CI/CD Catalog tools", () => {
  it("registers read-only catalog tools in the dedicated toolset", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ toolsets: ["ci-catalog"] })
    );

    try {
      const tools = (await client.listTools()).tools.filter((tool) =>
        tool.name.startsWith("gitlab_")
      );
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        ["gitlab_discover_tools", ...CI_CATALOG_TOOLS].sort()
      );
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false
        });
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes filters and cursor pagination to the global catalog query", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({
      data: {
        ciCatalogResources: {
          nodes: [{ id: "gid://gitlab/Ci::Catalog::Resource/1", name: "build" }],
          pageInfo: { hasNextPage: true, endCursor: "next" }
        }
      }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ toolsets: ["ci-catalog"], gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_ci_catalog_resources",
        arguments: {
          search: "build",
          first: 10,
          after: "cursor",
          topics: ["ci"],
          sort: "NAME_ASC"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalledWith(
        expect.stringContaining("query ListCiCatalogResources"),
        expect.objectContaining({
          search: "build",
          first: 10,
          after: "cursor",
          topics: ["ci"],
          sort: "NAME_ASC"
        })
      );
      expect(JSON.parse(textOf(result as never))).toEqual({
        nodes: [{ id: "gid://gitlab/Ci::Catalog::Resource/1", name: "build" }],
        pageInfo: { hasNextPage: true, endCursor: "next" }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("gets one resource and forwards nested pagination cursors", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({
      data: {
        ciCatalogResource: {
          id: "gid://gitlab/Ci::Catalog::Resource/1",
          versions: {
            nodes: [
              {
                name: "1.0.0",
                components: {
                  nodes: [{ name: "build" }, { name: "test" }],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            ],
            pageInfo: { hasNextPage: true, endCursor: "version-next" }
          }
        }
      }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ toolsets: ["ci-catalog"], gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_ci_catalog_resource",
        arguments: {
          full_path: "group/catalog",
          version_limit: 3,
          version_after: "versions",
          component_limit: 4,
          component_after: "components",
          component_name: "build"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalledWith(
        expect.stringContaining("query GetCiCatalogResource"),
        expect.objectContaining({
          fullPath: "group/catalog",
          versionLimit: 3,
          versionAfter: "versions",
          componentLimit: 4,
          componentAfter: "components"
        })
      );
      expect(textOf(result as never)).toContain('"name": "build"');
      expect(textOf(result as never)).not.toContain('"name": "test"');
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("requires exactly one resource identity", async () => {
    const executeGraphql = vi.fn();
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ toolsets: ["ci-catalog"], gitlabStub: { executeGraphql } })
    );

    try {
      for (const args of [
        {},
        { id: "gid://gitlab/Ci::Catalog::Resource/1", full_path: "group/catalog" }
      ]) {
        const result = await client.callTool({
          name: "gitlab_get_ci_catalog_resource",
          arguments: args
        });
        expect(result.isError).toBe(true);
        expect(textOf(result as never)).toContain("exactly one");
      }
      expect(executeGraphql).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("fails closed for strict project scope and the GraphQL capability denylist", async () => {
    for (const context of [
      buildContext({ toolsets: ["ci-catalog"], allowedProjectIds: ["group/project"] }),
      buildContext({ toolsets: ["ci-catalog"], disabledCapabilities: ["graphql"] })
    ]) {
      const { client, clientTransport, serverTransport } = await createLinkedPair(context);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).not.toEqual(expect.arrayContaining(CI_CATALOG_TOOLS));
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    }
  });
});
