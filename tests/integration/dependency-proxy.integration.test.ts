import { describe, expect, it, vi } from "vitest";

import { buildContext, createLinkedPair } from "./_helpers.js";

const DEPENDENCY_PROXY_TOOLS = [
  "gitlab_get_dependency_proxy_settings",
  "gitlab_update_dependency_proxy_settings",
  "gitlab_list_dependency_proxy_blobs",
  "gitlab_purge_dependency_proxy_cache"
];

function textOf(result: { content?: Array<{ type: string; text: string }> }): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("Dependency Proxy tools", () => {
  it("keeps every tool hidden until the explicit server opt-in is enabled", async () => {
    for (const toolsets of [[], ["all"], ["dependency-proxy"]] as const) {
      const { client, clientTransport, serverTransport } = await createLinkedPair(
        buildContext({ toolsets: [...toolsets] })
      );
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).not.toEqual(expect.arrayContaining(DEPENDENCY_PROXY_TOOLS));
        const discovery = await client.callTool({
          name: "gitlab_discover_tools",
          arguments: {
            query: "gitlab_get_dependency_proxy_settings",
            include_disabled: true,
            limit: 5
          }
        });
        expect(textOf(discovery as never)).toContain("explicit_enable");
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    }
  });

  it("registers the dedicated admin toolset with derived annotations", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ toolsets: ["dependency-proxy"], enableDependencyProxyTools: true })
    );

    try {
      const tools = (await client.listTools()).tools.filter((tool) =>
        tool.name.startsWith("gitlab_")
      );
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        ["gitlab_discover_tools", ...DEPENDENCY_PROXY_TOOLS].sort()
      );
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: tool.name === "gitlab_discover_tools",
          destructiveHint: tool.name === "gitlab_purge_dependency_proxy_cache"
        });
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("gets settings by full group path and maps cache usage fields", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({
      data: {
        group: {
          dependencyProxySetting: { enabled: true, identity: "docker-org" },
          dependencyProxyBlobCount: 4,
          dependencyProxyImageCount: 2,
          dependencyProxyTotalSize: "2 MiB",
          dependencyProxyTotalSizeBytes: "2097152",
          dependencyProxyImagePrefix: "gitlab.example.com/group/dependency_proxy/containers",
          dependencyProxyImageTtlPolicy: { enabled: true, ttl: 90 }
        }
      }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        gitlabStub: { executeGraphql }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_dependency_proxy_settings",
        arguments: { group_id: "group/subgroup" }
      });
      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalledWith(
        expect.stringContaining("query GetDependencyProxySettings"),
        { fullPath: "group/subgroup" }
      );
      expect(JSON.parse(textOf(result as never))).toMatchObject({
        enabled: true,
        identity: "docker-org",
        blob_count: 4,
        image_count: 2,
        total_size_bytes: "2097152",
        ttl_policy: { enabled: true, ttl: 90 }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("resolves numeric group IDs and forwards blob cursor pagination", async () => {
    const getGroup = vi.fn().mockResolvedValue({ full_path: "group/subgroup" });
    const executeGraphql = vi.fn().mockResolvedValue({
      data: {
        group: {
          dependencyProxyBlobs: {
            nodes: [
              {
                fileName: "sha256:abc",
                size: "1 KiB",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-02T00:00:00Z"
              }
            ],
            pageInfo: { hasNextPage: true, endCursor: "next" }
          }
        }
      }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        gitlabStub: { getGroup, executeGraphql }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_dependency_proxy_blobs",
        arguments: { group_id: "123", first: 10, after: "cursor" }
      });
      expect(result.isError).toBeFalsy();
      expect(getGroup).toHaveBeenCalledWith("123");
      expect(executeGraphql).toHaveBeenCalledWith(
        expect.stringContaining("query ListDependencyProxyBlobs"),
        { fullPath: "group/subgroup", first: 10, after: "cursor" }
      );
      expect(JSON.parse(textOf(result as never))).toEqual({
        blobs: [
          {
            file_name: "sha256:abc",
            size: "1 KiB",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z"
          }
        ],
        pageInfo: { hasNextPage: true, endCursor: "next" }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("updates settings without returning the supplied secret", async () => {
    const secret = "docker-hub-access-token";
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: { updateDependencyProxySettings: { errors: [] } }
      })
      .mockResolvedValueOnce({
        data: {
          group: {
            dependencyProxySetting: { enabled: true, identity: "docker-user" },
            dependencyProxyBlobCount: 0,
            dependencyProxyImageCount: 0,
            dependencyProxyTotalSize: "0 Bytes",
            dependencyProxyTotalSizeBytes: "0",
            dependencyProxyImagePrefix: "gitlab.example.com/group/dependency_proxy/containers",
            dependencyProxyImageTtlPolicy: null
          }
        }
      });
    const context = buildContext({
      toolsets: ["dependency-proxy"],
      enableDependencyProxyTools: true,
      gitlabStub: { executeGraphql }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.callTool({
        name: "gitlab_update_dependency_proxy_settings",
        arguments: {
          group_id: "group",
          enabled: true,
          identity: "docker-user",
          secret
        }
      });
      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("mutation UpdateDependencyProxySettings"),
        {
          input: {
            groupPath: "group",
            enabled: true,
            identity: "docker-user",
            secret
          }
        }
      );
      expect(textOf(result as never)).not.toContain(secret);
      expect(textOf(result as never)).toContain("docker-user");

      const logOutput = JSON.stringify([
        ...(context.logger.info as ReturnType<typeof vi.fn>).mock.calls,
        ...(context.logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        ...(context.logger.error as ReturnType<typeof vi.fn>).mock.calls,
        ...(context.logger.debug as ReturnType<typeof vi.fn>).mock.calls
      ]);
      expect(logOutput).not.toContain(secret);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("requires a setting and redacts secrets from mutation errors", async () => {
    const secret = "mutation-error-secret";
    const executeGraphql = vi.fn().mockResolvedValue({
      data: {
        updateDependencyProxySettings: {
          errors: [`secret ${secret} was rejected`]
        }
      }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        gitlabStub: { executeGraphql }
      })
    );

    try {
      const missingResult = await client.callTool({
        name: "gitlab_update_dependency_proxy_settings",
        arguments: { group_id: "group" }
      });
      expect(missingResult.isError).toBe(true);
      expect(textOf(missingResult as never)).toContain("at least one");
      expect(executeGraphql).not.toHaveBeenCalled();

      const errorResult = await client.callTool({
        name: "gitlab_update_dependency_proxy_settings",
        arguments: { group_id: "group", secret }
      });
      expect(errorResult.isError).toBe(true);
      expect(textOf(errorResult as never)).not.toContain(secret);
      expect(textOf(errorResult as never)).toContain("[REDACTED]");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("purges through the group REST endpoint and returns a scheduled status", async () => {
    const purgeDependencyProxyCache = vi.fn().mockResolvedValue(undefined);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        gitlabStub: { purgeDependencyProxyCache }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_purge_dependency_proxy_cache",
        arguments: { group_id: "group/subgroup" }
      });
      expect(result.isError).toBeFalsy();
      expect(purgeDependencyProxyCache).toHaveBeenCalledWith("group/subgroup");
      expect(JSON.parse(textOf(result as never))).toEqual({
        status: "scheduled",
        scope: "group",
        group_id: "group/subgroup"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("fails closed for project scope and admin policy", async () => {
    for (const context of [
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        allowedProjectIds: ["group/project"]
      }),
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        disabledCapabilities: ["admin"]
      }),
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        readOnlyMode: true
      })
    ]) {
      const { client, clientTransport, serverTransport } = await createLinkedPair(context);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).not.toEqual(expect.arrayContaining(DEPENDENCY_PROXY_TOOLS));
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    }
  });

  it("requires GraphQL capability only for the GraphQL-backed operations", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["dependency-proxy"],
        enableDependencyProxyTools: true,
        disabledCapabilities: ["graphql"]
      })
    );

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_purge_dependency_proxy_cache");
      expect(names).not.toContain("gitlab_get_dependency_proxy_settings");
      expect(names).not.toContain("gitlab_update_dependency_proxy_settings");
      expect(names).not.toContain("gitlab_list_dependency_proxy_blobs");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
