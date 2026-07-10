/**
 * Integration tests for GraphQL tool registration, mutation detection,
 * enforcement, and read-only policy.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, createLinkedPair } from "./_helpers.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getErrorText(result: { content?: Array<{ type: string; text: string }> }): string {
  const textContent = result.content?.find((c) => c.type === "text");
  return textContent?.text ?? "";
}

async function listToolNames(client: { listTools: () => Promise<{ tools: { name: string }[] }> }) {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

const GRAPHQL_TOOL_NAMES = [
  "gitlab_execute_graphql_query",
  "gitlab_execute_graphql_mutation",
  "gitlab_execute_graphql"
];

/* ------------------------------------------------------------------ */
/*  Tool registration / filtering                                      */
/* ------------------------------------------------------------------ */

describe("GraphQL tools: Registration", () => {
  it("GraphQL tools disabled when ALLOWED_PROJECT_IDS set without override", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ allowedProjectIds: ["123"] })
    );

    try {
      const names = await listToolNames(client);
      for (const gqlTool of GRAPHQL_TOOL_NAMES) {
        expect(names).not.toContain(gqlTool);
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("legacy project-scope override does not expose raw GraphQL tools", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["123"],
        allowGraphqlWithProjectScope: true
      })
    );

    try {
      const names = await listToolNames(client);
      for (const gqlTool of GRAPHQL_TOOL_NAMES) {
        expect(names).not.toContain(gqlTool);
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("graphql_mutation not registered in readonly mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true, enableCompatibilityAliases: true })
    );

    try {
      const names = await listToolNames(client);
      expect(names).not.toContain("gitlab_execute_graphql_mutation");
      // Query and compat tools should still be available
      expect(names).toContain("gitlab_execute_graphql_query");
      expect(names).toContain("gitlab_execute_graphql");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("modify mode keeps write/admin and raw mutation tools but hides delete tools", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ permissionMode: "modify" })
    );

    try {
      const names = await listToolNames(client);
      expect(names).toContain("gitlab_create_issue");
      expect(names).toContain("gitlab_update_project");
      expect(names).toContain("gitlab_execute_graphql_mutation");
      expect(names).not.toContain("gitlab_delete_issue");

      const discovery = await client.callTool({
        name: "gitlab_discover_tools",
        arguments: { query: "gitlab_delete_issue", include_disabled: true, limit: 10 }
      });
      const discoveryResult = JSON.parse(getErrorText(discovery as never)) as {
        tools: Array<{ name: string; disabled_reasons?: string[] }>;
      };
      expect(
        discoveryResult.tools.find((tool) => tool.name === "gitlab_delete_issue")
      ).toMatchObject({ disabled_reasons: ["policy"] });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Mutation detection and enforcement                                 */
/* ------------------------------------------------------------------ */

describe("GraphQL tools: Query/Mutation enforcement", () => {
  it("graphql_query accepts valid query", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { project: { id: 1 } } });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ enableCompatibilityAliases: true, gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_query",
        arguments: { query: '{ project(fullPath: "group/proj") { id } }' }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("graphql_query rejects mutation", async () => {
    const executeGraphql = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ enableCompatibilityAliases: true, gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_query",
        arguments: { query: "mutation { createProject(input: {}) { project { id } } }" }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("gitlab_execute_graphql_mutation");
      expect(executeGraphql).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("graphql_mutation accepts valid mutation", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { createProject: { id: 1 } } });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_mutation",
        arguments: {
          query: "mutation CreateProject { createProject(input: {}) { project { id } } }"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("modify mode allows non-destructive raw mutations", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { updateProject: { errors: [] } } });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ permissionMode: "modify", gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_mutation",
        arguments: {
          query: "mutation { updateProject(input: {}) { errors } }"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalledOnce();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("modify mode blocks destructive raw mutations before GitLab is called", async () => {
    const executeGraphql = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ permissionMode: "modify", gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_mutation",
        arguments: {
          query: "mutation { safeAlias: destroyProject(input: {}) { errors } }"
        }
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result as never)).toContain("destroyProject");
      expect(executeGraphql).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("graphql_mutation rejects non-mutation", async () => {
    const executeGraphql = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_mutation",
        arguments: { query: '{ project(fullPath: "group/proj") { id } }' }
      });

      expect(result.isError).toBe(true);
      const text = getErrorText(result as never);
      expect(text).toContain("gitlab_execute_graphql_query");
      expect(executeGraphql).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("query with 'mutation' in string literal passes as query", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { project: { id: 1 } } });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_query",
        arguments: {
          query: '{ project(name: "mutation thing") { id } }'
        }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Compat tool behavior                                               */
/* ------------------------------------------------------------------ */

describe("GraphQL tools: Compat (gitlab_execute_graphql)", () => {
  it("compat allows query", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { project: { id: 1 } } });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ enableCompatibilityAliases: true, gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql",
        arguments: { query: '{ project(fullPath: "group/proj") { id } }' }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("compat allows mutation in non-readonly mode", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { createProject: { id: 1 } } });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ enableCompatibilityAliases: true, gitlabStub: { executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql",
        arguments: { query: "mutation { createProject(input: {}) { project { id } } }" }
      });

      expect(result.isError).toBeFalsy();
      expect(executeGraphql).toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("compat applies the destructive mutation guard in modify mode", async () => {
    const executeGraphql = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        permissionMode: "modify",
        enableCompatibilityAliases: true,
        gitlabStub: { executeGraphql }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql",
        arguments: {
          query: "mutation { pruneContainerRepository(input: {}) { errors } }"
        }
      });

      expect(result.isError).toBe(true);
      expect(getErrorText(result as never)).toContain("pruneContainerRepository");
      expect(executeGraphql).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("compat mutation blocked in readonly mode", async () => {
    const executeGraphql = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        readOnlyMode: true,
        enableCompatibilityAliases: true,
        gitlabStub: { executeGraphql }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql",
        arguments: { query: "mutation { createProject(input: {}) { project { id } } }" }
      });

      expect(result.isError).toBe(true);
      expect(executeGraphql).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
