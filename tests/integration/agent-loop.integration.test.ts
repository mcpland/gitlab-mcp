/**
 * Integration tests simulating a full agent loop:
 *   LLM (scripted) → MCP client → MCP server (InMemoryTransport)
 *
 * This validates the entire closed-loop flow:
 *   1. Client calls tools/list to discover available tools
 *   2. ScriptedLLM decides which tool to call
 *   3. Client calls tools/call on the MCP server
 *   4. Tool result is returned to the LLM
 *   5. LLM produces final text output
 *
 * The GitLabClient is stubbed so no real network calls are made.
 */
import { describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AppContext } from "../../src/types/context.js";

import { buildContext, createLinkedPair } from "./_helpers.js";

/* ------------------------------------------------------------------ */
/*  LLM abstraction                                                    */
/* ------------------------------------------------------------------ */

type LLMContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface LLMResponse {
  content: LLMContent[];
}

interface LLM {
  create(args: {
    messages: unknown[];
    tools: Array<{ name: string; description?: string; input_schema?: unknown }>;
  }): Promise<LLMResponse>;
}

/**
 * A scripted LLM that returns pre-defined responses in order.
 * Each call to create() pops the next response from the script.
 */
class ScriptedLLM implements LLM {
  private callIndex = 0;

  constructor(private script: LLMResponse[]) {}

  async create(): Promise<LLMResponse> {
    if (this.callIndex >= this.script.length) {
      throw new Error(`ScriptedLLM: script exhausted after ${this.callIndex} calls`);
    }
    const response = this.script[this.callIndex];
    if (!response) {
      throw new Error(`ScriptedLLM: missing response at index ${this.callIndex}`);
    }

    this.callIndex += 1;
    return response;
  }
}

/* ------------------------------------------------------------------ */
/*  Agent loop implementation                                          */
/* ------------------------------------------------------------------ */

interface AgentResult {
  finalText: string[];
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  toolResults: unknown[];
}

async function runAgentLoop(params: {
  client: Client;
  llm: LLM;
  query: string;
  maxIterations?: number;
}): Promise<AgentResult> {
  const { client, llm, query, maxIterations = 10 } = params;

  // 1. Discover tools
  const toolsResponse = await client.listTools();
  const tools = toolsResponse.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  // 2. Conversation loop
  const messages: unknown[] = [{ role: "user", content: query }];
  const finalText: string[] = [];
  const toolCalls: AgentResult["toolCalls"] = [];
  const toolResults: unknown[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const response = await llm.create({ messages, tools });
    let didToolCall = false;

    for (const content of response.content) {
      if (content.type === "text") {
        finalText.push(content.text);
        continue;
      }

      if (content.type === "tool_use") {
        didToolCall = true;
        toolCalls.push({ name: content.name, arguments: content.input });

        // Call the actual MCP server tool
        const toolResult = await client.callTool({
          name: content.name,
          arguments: content.input
        });
        toolResults.push(toolResult);

        // Build conversation history (Anthropic-style)
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: content.id,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(toolResult.content)
                }
              ]
            }
          ]
        });

        break; // process next LLM turn
      }
    }

    if (!didToolCall) break;
  }

  return { finalText, toolCalls, toolResults };
}

/* ------------------------------------------------------------------ */
/*  Test helpers                                                       */
/* ------------------------------------------------------------------ */

function createAgentTestPair(gitlabStub?: Partial<AppContext["gitlab"]>) {
  return createLinkedPair(
    buildContext({
      serverName: "agent-test-server",
      gitlabStub: {
        listProjects: vi.fn().mockResolvedValue([
          { id: 1, name: "project-alpha", path_with_namespace: "group/project-alpha" },
          { id: 2, name: "project-beta", path_with_namespace: "group/project-beta" }
        ]),
        getProject: vi.fn().mockResolvedValue({
          id: 1,
          name: "project-alpha",
          path_with_namespace: "group/project-alpha",
          description: "Test project",
          default_branch: "main",
          web_url: "https://gitlab.example.com/group/project-alpha"
        }),
        listIssues: vi.fn().mockResolvedValue([
          { iid: 1, title: "Fix bug", state: "opened" },
          { iid: 2, title: "Add feature", state: "opened" }
        ]),
        ...gitlabStub
      }
    })
  );
}

/* ------------------------------------------------------------------ */
/*  Agent loop tests                                                   */
/* ------------------------------------------------------------------ */

describe("Agent Loop Integration (ScriptedLLM + MCP server)", () => {
  describe("single tool call flow", () => {
    it("completes a health_check tool call cycle", async () => {
      const { client, clientTransport, serverTransport } = await createAgentTestPair();

      try {
        const llm = new ScriptedLLM([
          // Turn 1: LLM decides to call health_check
          {
            content: [{ type: "tool_use", id: "call-1", name: "health_check", input: {} }]
          },
          // Turn 2: LLM sees tool result, produces final text
          {
            content: [{ type: "text", text: "Server is healthy!" }]
          }
        ]);

        const result = await runAgentLoop({
          client,
          llm,
          query: "Is the server healthy?"
        });

        // Verify tool was called
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]!.name).toBe("health_check");

        // Verify tool result was successful
        const toolResult = result.toolResults[0] as { isError?: boolean };
        expect(toolResult.isError).toBeFalsy();

        // Verify final output
        expect(result.finalText).toContain("Server is healthy!");
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    });

    it("completes a gitlab_list_projects tool call with mocked data", async () => {
      const { client, clientTransport, serverTransport, context } = await createAgentTestPair();

      try {
        const llm = new ScriptedLLM([
          {
            content: [{ type: "tool_use", id: "call-1", name: "gitlab_list_projects", input: {} }]
          },
          {
            content: [{ type: "text", text: "Found 2 projects." }]
          }
        ]);

        const result = await runAgentLoop({
          client,
          llm,
          query: "List all projects"
        });

        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0]!.name).toBe("gitlab_list_projects");

        // Verify the mocked gitlab client was called
        expect(context.gitlab.listProjects).toHaveBeenCalled();

        // Verify tool result contains data
        const toolResult = result.toolResults[0] as {
          isError?: boolean;
          content: Array<{ type: string; text: string }>;
        };
        expect(toolResult.isError).toBeFalsy();

        const text = toolResult.content.find((c) => c.type === "text")!.text;
        expect(text).toContain("project-alpha");
        expect(text).toContain("project-beta");

        expect(result.finalText).toContain("Found 2 projects.");
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    });
  });

  describe("multi-turn tool call flow", () => {
    it("handles sequential tool calls across multiple turns", async () => {
      const { client, clientTransport, serverTransport, context } = await createAgentTestPair();

      try {
        const llm = new ScriptedLLM([
          // Turn 1: List projects
          {
            content: [{ type: "tool_use", id: "call-1", name: "gitlab_list_projects", input: {} }]
          },
          // Turn 2: Get details on a specific project
          {
            content: [
              {
                type: "tool_use",
                id: "call-2",
                name: "gitlab_get_project",
                input: { project_id: "group/project-alpha" }
              }
            ]
          },
          // Turn 3: Final answer
          {
            content: [
              {
                type: "text",
                text: "project-alpha has default branch main."
              }
            ]
          }
        ]);

        const result = await runAgentLoop({
          client,
          llm,
          query: "Tell me about the first project"
        });

        expect(result.toolCalls).toHaveLength(2);
        expect(result.toolCalls[0]!.name).toBe("gitlab_list_projects");
        expect(result.toolCalls[1]!.name).toBe("gitlab_get_project");
        expect(result.toolCalls[1]!.arguments).toEqual({ project_id: "group/project-alpha" });

        expect(context.gitlab.listProjects).toHaveBeenCalled();
        expect(context.gitlab.getProject).toHaveBeenCalledWith("group/project-alpha");

        expect(result.finalText).toContain("project-alpha has default branch main.");
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    });
  });

  describe("text-only response (no tool call)", () => {
    it("handles LLM responding with text only", async () => {
      const { client, clientTransport, serverTransport } = await createAgentTestPair();

      try {
        const llm = new ScriptedLLM([
          {
            content: [{ type: "text", text: "I don't need any tools for this." }]
          }
        ]);

        const result = await runAgentLoop({
          client,
          llm,
          query: "Hello, how are you?"
        });

        expect(result.toolCalls).toHaveLength(0);
        expect(result.toolResults).toHaveLength(0);
        expect(result.finalText).toContain("I don't need any tools for this.");
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    });
  });

  describe("tool error handling in agent loop", () => {
    it("propagates tool errors back to LLM gracefully", async () => {
      const { client, clientTransport, serverTransport } = await createAgentTestPair({
        getProject: vi.fn().mockRejectedValue(new Error("Network timeout"))
      });

      try {
        const llm = new ScriptedLLM([
          {
            content: [
              {
                type: "tool_use",
                id: "call-1",
                name: "gitlab_get_project",
                input: { project_id: "broken/project" }
              }
            ]
          },
          // LLM sees the error and produces a helpful message
          {
            content: [
              {
                type: "text",
                text: "Sorry, I couldn't fetch the project due to a network error."
              }
            ]
          }
        ]);

        const result = await runAgentLoop({
          client,
          llm,
          query: "Get project details"
        });

        expect(result.toolCalls).toHaveLength(1);

        // Tool result should be an error
        const toolResult = result.toolResults[0] as { isError?: boolean };
        expect(toolResult.isError).toBe(true);

        // Agent still completes with final text from the scripted LLM
        expect(result.finalText.join("\n")).toContain("couldn't fetch the project");
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    });
  });

  describe("tool discovery", () => {
    it("agent discovers tools and LLM receives tool list", async () => {
      const { client, clientTransport, serverTransport } = await createAgentTestPair();

      try {
        let receivedTools: Array<{ name: string }> = [];

        const llm: LLM = {
          async create({ tools }) {
            receivedTools = tools;
            return { content: [{ type: "text", text: "Done" }] };
          }
        };

        await runAgentLoop({ client, llm, query: "test" });

        expect(receivedTools.length).toBeGreaterThan(0);

        const names = receivedTools.map((t) => t.name);
        expect(names).toContain("health_check");
        expect(names).toContain("gitlab_get_project");
        expect(names).toContain("gitlab_list_projects");
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    });
  });

  describe("iteration safety", () => {
    it("respects maxIterations to prevent infinite loops", async () => {
      const { client, clientTransport, serverTransport } = await createAgentTestPair();

      try {
        // LLM always requests another tool call, never stops
        const infiniteLLM: LLM = {
          callCount: 0,
          async create() {
            (this as { callCount: number }).callCount++;
            return {
              content: [
                {
                  type: "tool_use",
                  id: `call-${(this as { callCount: number }).callCount}`,
                  name: "health_check",
                  input: {}
                }
              ]
            };
          }
        } as LLM & { callCount: number };

        const result = await runAgentLoop({
          client,
          llm: infiniteLLM,
          query: "loop forever",
          maxIterations: 3
        });

        // Should stop after maxIterations
        expect(result.toolCalls).toHaveLength(3);
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    });
  });
});
