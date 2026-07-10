import { describe, expect, it, vi } from "vitest";

import { GitLabApiError } from "../../src/lib/gitlab-client.js";
import { attachPaginationMetadata } from "../../src/lib/pagination.js";
import { buildContext, createLinkedPair } from "./_helpers.js";

const PROJECT_VARIABLE_TOOLS = [
  "gitlab_list_project_variables",
  "gitlab_get_project_variable",
  "gitlab_create_project_variable",
  "gitlab_update_project_variable",
  "gitlab_delete_project_variable"
];
const GROUP_VARIABLE_TOOLS = [
  "gitlab_list_group_variables",
  "gitlab_get_group_variable",
  "gitlab_create_group_variable",
  "gitlab_update_group_variable",
  "gitlab_delete_group_variable"
];
const ALL_VARIABLE_TOOLS = [...PROJECT_VARIABLE_TOOLS, ...GROUP_VARIABLE_TOOLS];

function textOf(result: { content?: Array<{ type: string; text: string }> }): string {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

describe("CI/CD variable tools", () => {
  it("keeps every variable tool hidden until the explicit server opt-in is enabled", async () => {
    for (const toolsets of [[], ["all"], ["ci-variables"]] as const) {
      const { client, clientTransport, serverTransport } = await createLinkedPair(
        buildContext({ toolsets: [...toolsets] })
      );
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).not.toEqual(expect.arrayContaining(ALL_VARIABLE_TOOLS));
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    }
  });

  it("registers the dedicated toolset with capability-derived annotations", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ toolsets: ["ci-variables"], enableCiVariableTools: true })
    );

    try {
      const tools = (await client.listTools()).tools.filter((tool) =>
        tool.name.startsWith("gitlab_")
      );
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        ["gitlab_discover_tools", ...ALL_VARIABLE_TOOLS].sort()
      );

      for (const tool of tools) {
        const isDelete = tool.name.includes("_delete_");
        const isRead =
          tool.name === "gitlab_discover_tools" ||
          tool.name.includes("_list_") ||
          tool.name.includes("_get_");
        expect(tool.annotations).toMatchObject({
          readOnlyHint: isRead,
          destructiveHint: isDelete
        });
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("requires both value gates for project list and get responses", async () => {
    const secret = "never-return-without-both-gates";
    for (const testCase of [
      { serverAllows: false, callIncludes: false, expected: false },
      { serverAllows: false, callIncludes: true, expected: false },
      { serverAllows: true, callIncludes: false, expected: false },
      { serverAllows: true, callIncludes: true, expected: true }
    ]) {
      const listProjectVariables = vi
        .fn()
        .mockResolvedValue([
          { key: "TOKEN", value: secret, masked: true, hidden: false, unexpected: "omitted" }
        ]);
      const getProjectVariable = vi.fn().mockResolvedValue({
        key: "TOKEN",
        value: secret,
        masked: true,
        hidden: false,
        unexpected: "omitted"
      });
      const { client, clientTransport, serverTransport } = await createLinkedPair(
        buildContext({
          toolsets: ["ci-variables"],
          enableCiVariableTools: true,
          allowCiVariableValues: testCase.serverAllows,
          gitlabStub: { listProjectVariables, getProjectVariable }
        })
      );

      try {
        for (const call of [
          {
            name: "gitlab_list_project_variables",
            arguments: { project_id: "group/project", include_value: testCase.callIncludes }
          },
          {
            name: "gitlab_get_project_variable",
            arguments: {
              project_id: "group/project",
              key: "TOKEN",
              include_value: testCase.callIncludes
            }
          }
        ]) {
          const result = await client.callTool(call);
          expect(result.isError).toBeFalsy();
          expect(textOf(result as never).includes(secret)).toBe(testCase.expected);
          expect(textOf(result as never)).not.toContain("unexpected");
        }
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    }
  });

  it("reports the explicit opt-in gate during discovery and preserves list pagination", async () => {
    const hiddenPair = await createLinkedPair(buildContext({ toolsets: ["ci-variables"] }));

    try {
      const discovery = await hiddenPair.client.callTool({
        name: "gitlab_discover_tools",
        arguments: { query: "gitlab_list_project_variables", include_disabled: true, limit: 5 }
      });
      expect(textOf(discovery as never)).toContain("explicit_enable");
    } finally {
      await hiddenPair.clientTransport.close();
      await hiddenPair.serverTransport.close();
    }

    const variables = attachPaginationMetadata([{ key: "TOKEN", value: "hidden" }], {
      page: 1,
      next_page: 2,
      per_page: 20
    });
    const visiblePair = await createLinkedPair(
      buildContext({
        toolsets: ["ci-variables"],
        enableCiVariableTools: true,
        gitlabStub: { listProjectVariables: vi.fn().mockResolvedValue(variables) }
      })
    );

    try {
      const result = await visiblePair.client.callTool({
        name: "gitlab_list_project_variables",
        arguments: { project_id: "group/project" }
      });
      expect(result.structuredContent).toMatchObject({
        meta: { pagination: { page: 1, next_page: 2, per_page: 20 } }
      });
      expect(textOf(result as never)).not.toContain("hidden");
    } finally {
      await visiblePair.clientTransport.close();
      await visiblePair.serverTransport.close();
    }
  });

  it("never returns write values and redacts them from upstream errors", async () => {
    const secret = "write-only-super-secret";
    const createProjectVariable = vi.fn().mockResolvedValue({
      key: "TOKEN",
      value: secret,
      masked: true,
      hidden: false
    });
    const updateProjectVariable = vi.fn().mockRejectedValue(
      new GitLabApiError("upstream rejected variable", 400, {
        value: secret,
        message: `value ${secret} is invalid`
      })
    );
    const context = buildContext({
      toolsets: ["ci-variables"],
      enableCiVariableTools: true,
      allowCiVariableValues: true,
      gitlabStub: { createProjectVariable, updateProjectVariable }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const createResult = await client.callTool({
        name: "gitlab_create_project_variable",
        arguments: { project_id: "group/project", key: "TOKEN", value: secret, masked: true }
      });
      expect(createResult.isError).toBeFalsy();
      expect(textOf(createResult as never)).not.toContain(secret);
      expect(createProjectVariable).toHaveBeenCalledWith(
        "group/project",
        expect.objectContaining({ key: "TOKEN", value: secret, masked: true })
      );

      const updateResult = await client.callTool({
        name: "gitlab_update_project_variable",
        arguments: { project_id: "group/project", key: "TOKEN", value: secret }
      });
      expect(updateResult.isError).toBe(true);
      expect(textOf(updateResult as never)).not.toContain(secret);
      expect(textOf(updateResult as never)).toContain("[REDACTED]");

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

  it("forwards pagination and environment-scope filters without mixing them into bodies", async () => {
    const listGroupVariables = vi.fn().mockResolvedValue([]);
    const getGroupVariable = vi.fn().mockResolvedValue({ key: "TOKEN", value: "secret" });
    const updateProjectVariable = vi.fn().mockResolvedValue({ key: "TOKEN", value: "new-secret" });
    const deleteGroupVariable = vi.fn().mockResolvedValue(undefined);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["ci-variables"],
        enableCiVariableTools: true,
        gitlabStub: {
          listGroupVariables,
          getGroupVariable,
          updateProjectVariable,
          deleteGroupVariable
        }
      })
    );

    try {
      await client.callTool({
        name: "gitlab_list_group_variables",
        arguments: {
          group_id: "group/subgroup",
          page: 2,
          per_page: 50,
          filter: { environment_scope: "production" },
          include_value: true
        }
      });
      expect(listGroupVariables).toHaveBeenCalledWith("group/subgroup", {
        query: { page: 2, per_page: 50, "filter[environment_scope]": "production" }
      });

      await client.callTool({
        name: "gitlab_get_group_variable",
        arguments: {
          group_id: "group/subgroup",
          key: "TOKEN",
          filter: { environment_scope: "production" }
        }
      });
      expect(getGroupVariable).toHaveBeenCalledWith("group/subgroup", "TOKEN", {
        query: { "filter[environment_scope]": "production" }
      });

      await client.callTool({
        name: "gitlab_update_project_variable",
        arguments: {
          project_id: "group/project",
          key: "TOKEN",
          value: "new-secret",
          environment_scope: "production",
          filter: { environment_scope: "staging" }
        }
      });
      expect(updateProjectVariable).toHaveBeenCalledWith(
        "group/project",
        "TOKEN",
        { value: "new-secret", environment_scope: "production" },
        { query: { "filter[environment_scope]": "staging" } }
      );

      await client.callTool({
        name: "gitlab_delete_group_variable",
        arguments: {
          group_id: "group/subgroup",
          key: "TOKEN",
          filter: { environment_scope: "production" }
        }
      });
      expect(deleteGroupVariable).toHaveBeenCalledWith("group/subgroup", "TOKEN", {
        query: { "filter[environment_scope]": "production" }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("keeps project tools inside strict project scope and hides every group tool", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["ci-variables"],
        enableCiVariableTools: true,
        allowedProjectIds: ["group/project"]
      })
    );

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(PROJECT_VARIABLE_TOOLS));
      expect(names).not.toEqual(expect.arrayContaining(GROUP_VARIABLE_TOOLS));
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("keeps only read operations in read-only mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        toolsets: ["ci-variables"],
        enableCiVariableTools: true,
        readOnlyMode: true
      })
    );

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "gitlab_list_project_variables",
          "gitlab_get_project_variable",
          "gitlab_list_group_variables",
          "gitlab_get_group_variable"
        ])
      );
      expect(names).not.toEqual(
        expect.arrayContaining([
          "gitlab_create_project_variable",
          "gitlab_update_project_variable",
          "gitlab_delete_project_variable"
        ])
      );
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
