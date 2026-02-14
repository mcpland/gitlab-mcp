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

  it("GraphQL tools enabled with ALLOW_GRAPHQL_WITH_PROJECT_SCOPE", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["123"],
        allowGraphqlWithProjectScope: true
      })
    );

    try {
      const names = await listToolNames(client);
      for (const gqlTool of GRAPHQL_TOOL_NAMES) {
        expect(names).toContain(gqlTool);
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("graphql_mutation not registered in readonly mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true })
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
});

/* ------------------------------------------------------------------ */
/*  Mutation detection and enforcement                                 */
/* ------------------------------------------------------------------ */

describe("GraphQL tools: Query/Mutation enforcement", () => {
  it("graphql_query accepts valid query", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { project: { id: 1 } } });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { executeGraphql } })
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
      buildContext({ gitlabStub: { executeGraphql } })
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
      buildContext({ gitlabStub: { executeGraphql } })
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
      buildContext({ gitlabStub: { executeGraphql } })
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

  it("compat mutation blocked in readonly mode", async () => {
    const executeGraphql = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true, gitlabStub: { executeGraphql } })
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
