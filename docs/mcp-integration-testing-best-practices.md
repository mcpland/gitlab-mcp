# MCP Integration Testing Best Practices

> This article is based on hands-on experience with 324 test cases from the gitlab-mcp project, combined with the official MCP SDK, Inspector CLI, and community-recommended practices, to systematically summarize the methodology and implementation patterns for MCP Server integration testing.
>
> Scope note: This is a general methodology article. Code snippets, environment variable names, file paths, and npm scripts are illustrative examples and should be adapted to your repository layout and conventions.

## Table of Contents

- [Why MCP Servers Need Integration Testing](#why-mcp-servers-need-integration-testing)
- [The Testing Pyramid: MCP Edition](#the-testing-pyramid-mcp-edition)
- [Layer 1: InMemoryTransport Protocol-Level Testing](#layer-1-inmemorytransport-protocol-level-testing)
  - [Core Scaffolding: buildContext + createLinkedPair](#core-scaffolding-buildcontext--createlinkedpair)
  - [Pattern 1: Tool Registration and Discovery](#pattern-1-tool-registration-and-discovery)
  - [Pattern 2: Tool Handler End-to-End Verification](#pattern-2-tool-handler-end-to-end-verification)
  - [Pattern 3: Schema Validation and Boundary Inputs](#pattern-3-schema-validation-and-boundary-inputs)
- [Layer 2: HTTP Transport Layer Testing](#layer-2-http-transport-layer-testing)
  - [Streamable HTTP Testing](#streamable-http-testing)
  - [SSE Transport Testing](#sse-transport-testing)
  - [Session Lifecycle Testing](#session-lifecycle-testing)
- [Layer 3: Security and Policy Testing](#layer-3-security-and-policy-testing)
  - [Remote Authentication Flow](#remote-authentication-flow)
  - [Error Handling and Sensitive Information Redaction](#error-handling-and-sensitive-information-redaction)
  - [Policy Engine: Read-Only, Feature Flags, Allowlists](#policy-engine-read-only-feature-flags-allowlists)
- [Layer 4: Agent Loop Integration Testing](#layer-4-agent-loop-integration-testing)
  - [ScriptedLLM Pattern](#scriptedllm-pattern)
  - [Real LLM Smoke Testing](#real-llm-smoke-testing)
- [Layer 5: Inspector CLI Black-Box Testing](#layer-5-inspector-cli-black-box-testing)
- [CI/CD Integration Strategy](#cicd-integration-strategy)
- [Common Pitfalls and Solutions](#common-pitfalls-and-solutions)
- [Summary: Recommended Test Matrix](#summary-recommended-test-matrix)

---

## Why MCP Servers Need Integration Testing

An MCP Server is not an ordinary HTTP API. It has several characteristics that make testing more complex:

1. **Stateful sessions**: The client must first `initialize` to obtain a session ID, and all subsequent requests must include it
2. **Multiple transport protocols**: The same server may simultaneously support Streamable HTTP, SSE, and stdio
3. **Bidirectional communication**: In SSE mode, the server can proactively push events to the client
4. **Policy layer**: Read-only mode, tool allowlists, and feature flags can alter the available tool set
5. **Authentication context**: In remote deployments, tokens are passed via HTTP headers and must propagate through AsyncLocalStorage

Pure unit tests cannot cover these interactions. You need a real MCP Client and Server communicating through a real (or in-memory simulated) transport layer to verify the complete request-response chain.

A common anti-pattern in the community is so-called **"Vibe Testing"** — spinning up an LLM Agent, typing a few prompts, and considering it passed if the output "looks about right." This approach is non-deterministic, non-reproducible, and expensive. The correct approach is to build a **deterministic, automatable, layered** integration testing system.

---

## The Testing Pyramid: MCP Edition

```
                    ┌─────────────┐
                    │  LLM E2E    │  ← Few, Nightly
                    │  Smoke Test │
                   ─┤             ├─
                  / └─────────────┘ \
                 /   Inspector CLI   \  ← Black-box contract test
                / ┌─────────────────┐ \
               /  │  Security /     │  \
              /   │  Policy / Error │   \  ← Every PR
             / ┌──┴─────────────────┴──┐ \
            /  │  HTTP / SSE Transport  │  \
           /   │  Session Lifecycle     │   \
          / ┌──┴───────────────────────┴──┐ \
         /  │  InMemoryTransport Protocol  │  \  ← Every commit
        /   │  Registration / Schema /     │   \
       /    │  Handler                     │    \
      └────────────────────────────────────────┘
```

**Principle: The lower the layer, the more tests, the faster, and the more deterministic.**

---

## Layer 1: InMemoryTransport Protocol-Level Testing

This is the **cornerstone** of MCP integration testing. Using the official TypeScript SDK's `InMemoryTransport.createLinkedPair()`, you can connect Client and Server directly within the same process — no child processes or HTTP servers needed.

**Advantages**:

- Extremely fast (millisecond-level)
- Fully deterministic, no network/port dependencies
- Tests the real MCP protocol handshake and tool invocation chain

### Core Scaffolding: buildContext + createLinkedPair

Extracting the server creation logic into a factory function is the key to testability. In tests, you import the factory directly and use dependency injection to replace external services.

```typescript
// tests/integration/_helpers.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/server/build-server.js";

// 1) Build test context — all external dependencies can be stubbed
export function buildContext(overrides?: BuildContextOptions): AppContext {
  return {
    env: {
      ...defaultEnv,                           // Complete default configuration
      GITLAB_READ_ONLY_MODE: overrides?.readOnlyMode ?? false,
      GITLAB_ALLOWED_PROJECT_IDS: overrides?.allowedProjectIds ?? [],
      // ... other overridable fields
    },
    logger: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
      child: () => ({}) as never
    },
    gitlab: { ...overrides?.gitlabStub },      // Key: inject stub
    policy: new ToolPolicyEngine({ ... }),      // Real policy engine
    formatter: new OutputFormatter({ ... })     // Real formatter
  };
}

// 2) Create Client ↔ Server linked pair
export async function createLinkedPair(context: AppContext) {
  const server = createMcpServer(context);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client(
    { name: "integration-test-client", version: "0.0.1" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  return { client, server, clientTransport, serverTransport, context };
}
```

> **Best Practice**: `createMcpServer()` should be a **pure factory function** that accepts a complete context object and does not depend on global state or environment variables. This allows tests to construct server instances with any configuration.

### Pattern 1: Tool Registration and Discovery

Verify that `tools/list` returns the expected tool set — this is the most basic contract test.

```typescript
describe("Tool Registration", () => {
  it("registers all core tools under default configuration", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(buildContext());
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(names).toContain("gitlab_get_project");
      expect(names).toContain("gitlab_list_issues");
      expect(names).toContain("health_check");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("excludes all mutating tools in read-only mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true })
    );
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_create_issue");
      expect(names).not.toContain("gitlab_execute_graphql_mutation");
      // Read-only tools are still present
      expect(names).toContain("gitlab_get_project");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
```

> **Key Point**: Always close both transport endpoints in the `finally` block. InMemoryTransport does not clean up automatically — if you miss this, subsequent tests will hang.

### Pattern 2: Tool Handler End-to-End Verification

Use `client.callTool()` to make real JSON-RPC calls, stub external APIs (such as GitLab), and verify three things:

1. The correct API method is called with the right arguments
2. The response structure conforms to the MCP specification (`content[].text` + `structuredContent`)
3. Error scenarios return `isError: true`

```typescript
describe("Tool handler: gitlab_get_project", () => {
  it("passes project_id to context.gitlab.getProject()", async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 42,
      name: "my-project",
      path_with_namespace: "group/my-project"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: { getProject }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/my-project" }
      });

      // Verification 1: stub was called correctly
      expect(getProject).toHaveBeenCalledWith("group/my-project");

      // Verification 2: response is not an error
      expect(result.isError).toBeFalsy();

      // Verification 3: text content contains expected data
      const text = (result.content as Array<{ text: string }>).find((c) => c.type === "text")!.text;
      expect(text).toContain("my-project");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
```

> **Best Practice**: `gitlabStub` only needs to provide the methods used by the current test. Unstubbed method calls will produce runtime errors, which is **exactly** the behavior you want — it helps you discover unexpected API calls.

### Pattern 3: Schema Validation and Boundary Inputs

The MCP SDK's Zod schemas automatically validate input parameters. You should test:

- `null` value preprocessing (`null → undefined`)
- Missing required fields
- Type mismatches
- Invalid enum values

```typescript
describe("Schema Validation", () => {
  it("null values are preprocessed to undefined (optional fields do not error)", async () => {
    const listProjects = vi.fn().mockResolvedValue([]);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: { listProjects }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: { search: null, page: null } // null → undefined
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("type mismatch triggers Zod error", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: { listProjects: vi.fn() }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: { page: "not-a-number" } // should be number
      });
      expect(result.isError).toBe(true);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
```

---

## Layer 2: HTTP Transport Layer Testing

InMemoryTransport skips serialization and the network layer. To test real HTTP endpoints, you need to start a real HTTP server.

### Streamable HTTP Testing

**Key Pattern**: Use port 0 to let the OS assign a random port, avoiding port conflicts.

```typescript
import { createServer, type Server as HttpServer } from "node:http";
import { setupMcpHttpApp } from "../../src/http-app.js";

let httpServer: HttpServer;
let baseUrl: string;
let result: SetupMcpHttpAppResult;

beforeAll(async () => {
  const context = buildHttpContext();
  result = setupMcpHttpApp({
    context,
    env: context.env,
    logger: context.logger
  });

  httpServer = createServer(result.app);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = httpServer.address();
  if (typeof addr === "object" && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  // Key: close all sessions first, then shut down the HTTP server
  for (const sessionId of result.sessions.keys()) {
    await result.closeSession(sessionId, "shutdown");
  }
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});
```

**Typical Test Scenarios**:

| Scenario                        | HTTP Method                  | Expected Status | Error Code |
| ------------------------------- | ---------------------------- | --------------- | ---------- |
| Initialize session              | `POST /mcp` (initialize)     | 200             | —          |
| Subsequent request with session | `POST /mcp`                  | 200             | —          |
| Invalid session ID              | `POST /mcp`                  | 404             | -32001     |
| GET without initialization      | `GET /mcp`                   | 400             | -32000     |
| Capacity exceeded               | `POST /mcp` (MAX_SESSIONS=1) | 503             | -32002     |
| Rate limiting                   | `POST /mcp` (excessive)      | 429             | -32003     |
| Delete session                  | `DELETE /mcp`                | 200             | —          |
| Health check                    | `GET /healthz`               | 200             | —          |

> **Best Practice**: Each test scenario requiring independent configuration (e.g., `MAX_SESSIONS=1`) should create its own `setupMcpHttpApp` + `createServer` instance, cleaning up in a `finally` block. Do not share stateful server instances.

### SSE Transport Testing

SSE testing is more complex than HTTP because `GET /sse` returns a long-lived event stream:

```typescript
// SSE event parser
async function* parseSseEvents(response: Response): AsyncGenerator<SseEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const event: SseEvent = {};
        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) event.event = line.slice(7).trim();
          else if (line.startsWith("data: ")) event.data = line.slice(6).trim();
        }
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

**SSE Test Flow**:

```typescript
it("GET /sse returns an endpoint event", async () => {
  const controller = new AbortController();
  try {
    const response = await fetch(`${baseUrl}/sse`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const gen = parseSseEvents(response);
    const first = await gen.next();
    const event = first.value as SseEvent;

    expect(event.event).toBe("endpoint");
    expect(event.data).toContain("/messages?sessionId=");
  } finally {
    controller.abort(); // Required: clean up the long-lived connection
  }
});
```

> **Note**: In SSE mode, when calling `handlePostMessage` via `POST /messages`, you must pass `req.body` as the third argument, because Express's `json()` middleware has already consumed the raw body stream. This is a common pitfall.

> **Important**: `SSE=true` is incompatible with `REMOTE_AUTHORIZATION=true`. The environment validation layer enforces this constraint at startup. If you need remote per-request authentication, use Streamable HTTP transport instead.

### Session Lifecycle Testing

Session management is the most bug-prone area of an MCP Server. You must test the complete lifecycle:

```typescript
describe("Session DELETE", () => {
  it("POST with the same session returns 404 after DELETE", async () => {
    const sessionId = await initializeSession(baseUrl);

    // Delete the session
    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionId }
    });

    // Attempt to use the deleted session
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.code).toBe(-32001);
  });
});
```

**Garbage Collection Testing**: Trigger immediate expiration by setting `SESSION_TIMEOUT_SECONDS` to 0:

```typescript
it("GC cleans up expired sessions", async () => {
  (ctx.env as any).SESSION_TIMEOUT_SECONDS = 0;
  // ... create session ...
  expect(result.sessions.size).toBe(1);

  await result.garbageCollectSessions();
  expect(result.sessions.size).toBe(0);
});
```

**Client Disconnection Testing** requires polling, since TCP close is not synchronous:

```typescript
it("SSE session is cleaned up after client disconnects", async () => {
  controller.abort();

  const deadline = Date.now() + 2000;
  while (result.sseSessions.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(result.sseSessions.size).toBe(0);
});
```

---

## Layer 3: Security and Policy Testing

### Remote Authentication Flow

When `REMOTE_AUTHORIZATION=true`, the token comes from the HTTP header rather than an environment variable:

```typescript
function buildRemoteAuthContext() {
  const ctx = buildContext({ token: null }); // No default token
  (ctx.env as any).REMOTE_AUTHORIZATION = true;
  (ctx.env as any).HTTP_JSON_ONLY = true;
  return ctx;
}

describe("Remote Authentication", () => {
  it("missing token returns 401 + error code -32010", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS, // No Authorization
      body: initializeBody()
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error?.code).toBe(-32010);
  });

  it("Bearer token is passed via Authorization header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-remote-token"
      },
      body: initializeBody()
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("authentication context propagates to session state", async () => {
    // Initialize session with token
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer my-secret-token"
      },
      body: initializeBody()
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;

    // Verify internal auth state of the session
    const session = result.sessions.get(sessionId);
    expect(session!.auth?.token).toBe("my-secret-token");
    expect(session!.auth?.header).toBe("authorization");
  });
});
```

### Error Handling and Sensitive Information Redaction

Error handling is a security-critical path. Two modes need to be tested:

| Mode   | `GITLAB_ERROR_DETAIL_MODE` | Behavior                                                           |
| ------ | -------------------------- | ------------------------------------------------------------------ |
| `full` | Implementation-dependent   | Returns full error details (better debugging, higher leakage risk) |
| `safe` | Recommended for production | Hides internal details, returns generic messages                   |

```typescript
describe("Error Handling", () => {
  it("GitLabApiError 404 → isError + status code", async () => {
    const getProject = vi.fn().mockRejectedValue(new GitLabApiError("Not Found", 404));
    // ...
    expect(result.isError).toBe(true);
    expect(text).toContain("GitLab API error 404");
  });

  it("safe mode hides error details", async () => {
    (ctx.env as any).GITLAB_ERROR_DETAIL_MODE = "safe";

    const getProject = vi
      .fn()
      .mockRejectedValue(new Error("DB connection failed: password=hunter2"));
    // ...
    expect(text).toBe("Request failed"); // Generic message
    expect(text).not.toContain("hunter2"); // No leakage
  });

  it("non-Error thrown values return Unknown error", async () => {
    const getProject = vi.fn().mockRejectedValue("string error");
    // ...
    expect(text).toBe("Unknown error");
  });
});
```

**Token Redaction Testing** — ensure tokens are not leaked in error details. Using `it.each` reduces boilerplate when testing multiple token patterns:

```typescript
describe("Token Redaction", () => {
  it.each([
    ["GitLab PAT", "glpat-abcdef1234567890"],
    ["GitHub PAT", "ghp_abcdef1234567890abcde"],
    ["JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload"]
  ])("redacts %s token", async (label, token) => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("Unauthorized", 401, {
        message: `Token ${token} is invalid`
      })
    );
    // ...
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(token);
  });

  it("redacts sensitive object keys (authorization, password, secret)", async () => {
    const getProject = vi.fn().mockRejectedValue(
      new GitLabApiError("Error", 400, {
        authorization: "Bearer secret-val",
        password: "hunter2",
        message: "safe value" // Non-sensitive key is preserved
      })
    );
    // ...
    expect(text).not.toContain("secret-val");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("safe value");
  });
});
```

### Policy Engine: Read-Only, Feature Flags, Allowlists

The policy engine determines which tools are available. You must test various combinations:

```typescript
describe("GraphQL Tool Policy", () => {
  it("disables GraphQL tools when ALLOWED_PROJECT_IDS is set", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ allowedProjectIds: ["123"] })
    );
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("gitlab_execute_graphql_query");
      expect(names).not.toContain("gitlab_execute_graphql_mutation");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE overrides the restriction", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["123"],
        allowGraphqlWithProjectScope: true
      })
    );
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("gitlab_execute_graphql_query");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("compat tool blocks mutation in read-only mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true, gitlabStub: { executeGraphql: vi.fn() } })
    );
    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql",
        arguments: { query: "mutation { createProject { id } }" }
      });
      expect(result.isError).toBe(true);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("string literal containing 'mutation' does not trigger false positive", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: {} });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { executeGraphql } })
    );
    try {
      const result = await client.callTool({
        name: "gitlab_execute_graphql_query",
        arguments: { query: '{ project(name: "mutation thing") { id } }' }
      });
      expect(result.isError).toBeFalsy(); // Should not error
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
```

---

## Layer 4: Agent Loop Integration Testing

### ScriptedLLM Pattern

The real MCP use case is an LLM Agent calling tools. However, testing directly with a real LLM is non-deterministic, slow, and expensive. The recommended approach is **ScriptedLLM** — a pre-programmed sequence of LLM responses.

> **Note**: Layer 4 and Layer 5 patterns are high-value strategies. Some teams already implement them, while others can adopt them incrementally as a roadmap.

```typescript
class ScriptedLLM {
  private cursor = 0;
  constructor(private responses: LLMResponse[]) {}

  async createMessage(messages: Message[], tools: Tool[]) {
    if (this.cursor >= this.responses.length) {
      // Default end response
      return { content: [{ type: "text", text: "Done" }] };
    }
    return this.responses[this.cursor++];
  }
}

// Test case
it("Agent calls tool and processes result", async () => {
  const listProjects = vi.fn().mockResolvedValue([{ id: 1, name: "alpha" }]);

  const { client } = await createLinkedPair(buildContext({ gitlabStub: { listProjects } }));

  const llm = new ScriptedLLM([
    // Round 1: LLM decides to call a tool
    {
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "gitlab_list_projects",
          input: { search: "alpha" }
        }
      ]
    },
    // Round 2: LLM sees tool result and gives final answer
    {
      content: [{ type: "text", text: "Found project alpha" }]
    }
  ]);

  const result = await runAgentLoop({ client, llm, query: "find alpha" });

  expect(listProjects).toHaveBeenCalled();
  expect(result).toContain("alpha");
});
```

**Key Assertion Strategies**:

- Assert **whether a tool was called** and **with what arguments** — deterministic
- Assert **the final output contains key information** — semi-deterministic
- **Do not** assert the full text of natural language output — unstable

### Real LLM Smoke Testing

A small number of scenarios can use a real LLM (run in nightly CI):

```typescript
// Only run in CI with an API key
describe.skipIf(!process.env.ANTHROPIC_API_KEY)("LLM E2E Smoke", () => {
  it("can discover and call the health_check tool", async () => {
    const result = await runAgentLoop({
      client,
      llm: new AnthropicLLM(process.env.ANTHROPIC_API_KEY!),
      query: "Check the server health"
    });

    // Loose assertion — just needs to produce a result
    expect(result.length).toBeGreaterThan(0);
  }, 30_000); // Generous timeout
});
```

---

## Layer 5: Inspector CLI Black-Box Testing

[MCP Inspector](https://github.com/modelcontextprotocol/inspector)'s `--cli` mode is designed for scripting and CI, outputting JSON format. It's ideal for **black-box contract testing**.

### Local STDIO Testing

Use your project’s actual compiled stdio entrypoint (for example, `dist/index.js`).

```bash
# List tools
npx @modelcontextprotocol/inspector --cli \
  node dist/index.js \
  --method tools/list

# Call a tool
npx @modelcontextprotocol/inspector --cli \
  node dist/index.js \
  --method tools/call \
  --tool-name health_check
```

### Remote HTTP Testing

```bash
# Streamable HTTP (with auth header)
npx @modelcontextprotocol/inspector --cli \
  https://my-mcp-server.example.com \
  --transport http \
  --method tools/list \
  --header "Authorization: Bearer $TOKEN"
```

### Embedding in Vitest

```typescript
import { execa } from "execa";

test("Inspector CLI: tool list contains health_check", async () => {
  const { stdout } = await execa("npx", [
    "-y",
    "@modelcontextprotocol/inspector",
    "--cli",
    "node",
    "dist/index.js",
    "--method",
    "tools/list"
  ]);

  const res = JSON.parse(stdout);
  const names = res.tools.map((t: { name: string }) => t.name);
  expect(names).toContain("health_check");
});
```

> **When to use Inspector CLI vs SDK tests**: If you want stable API-level tests (unaffected by CLI output format changes), prefer SDK + InMemoryTransport. Inspector CLI is better suited for post-deployment smoke verification.

---

## CI/CD Integration Strategy

### Recommended Layered Strategy

| Trigger           | Test Type                        | Tools                | Duration |
| ----------------- | -------------------------------- | -------------------- | -------- |
| Every commit / PR | InMemoryTransport protocol tests | Vitest + SDK         | < 5s     |
| Every commit / PR | HTTP/SSE transport layer tests   | Vitest + real server | < 10s    |
| Every commit / PR | Security/policy/error handling   | Vitest + SDK         | < 5s     |
| Every PR          | Inspector CLI contract test      | Inspector --cli      | < 15s    |
| Nightly           | Agent Loop (ScriptedLLM)         | Vitest + SDK         | < 30s    |
| Nightly           | LLM E2E smoke test               | Vitest + real LLM    | < 60s    |
| Pre-release       | Containerized full-stack test    | Docker + Inspector   | < 5min   |

### package.json Script Organization

The following script layout is one practical example. Rename or regroup scripts based on your repository structure and CI strategy.

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "vitest run tests/e2e",
    "test:smoke": "vitest run tests/smoke --timeout=60000",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  }
}
```

### CI Configuration Essentials

```yaml
# .github/workflows/test.yml or equivalent .gitlab-ci.yml
test:
  steps:
    - run: pnpm typecheck # Type check first
    - run: pnpm lint # Then lint
    - run: pnpm test # Finally run all tests
```

> **Note**: For SSE tests involving TCP connection closure (e.g., client disconnection), use **polling with a deadline** instead of a fixed `setTimeout` to avoid flaky tests caused by timing differences in CI environments.

---

## Common Pitfalls and Solutions

### 1. Express Body Parser Conflicts with SSE handlePostMessage

**Problem**: The `express.json()` middleware consumes the raw body stream, causing `SSEServerTransport.handlePostMessage()` to fail internally when calling `getRawBody()` with a `stream is not readable` error.

**Solution**: Always pass `req.body` as the third argument:

```typescript
// ✗ Wrong
await session.transport.handlePostMessage(req, res);

// ✓ Correct
await session.transport.handlePostMessage(req, res, req.body);
```

### 2. Unclosed InMemoryTransport Causes Tests to Hang

**Problem**: Forgetting to close transports causes the test process to never exit.

**Solution**: Always use the `try/finally` pattern:

```typescript
const { client, clientTransport, serverTransport } = await createLinkedPair(context);
try {
  // Test logic
} finally {
  await clientTransport.close();
  await serverTransport.close();
}
```

### 3. Shared HTTP Server Causes State Leakage

**Problem**: Multiple tests share the same `setupMcpHttpApp` instance, and session state bleeds between them.

**Solution**: Tests requiring independent configuration (e.g., `MAX_SESSIONS=1`) should create their own server instance and clean up in `finally`.

### 4. Timing Issues with SSE Client Disconnection

**Problem**: After `controller.abort()`, the server-side `res.on("close")` callback is not triggered synchronously.

**Solution**: Use polling with a deadline:

```typescript
const deadline = Date.now() + 2000;
while (sessions.size > 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}
```

### 5. False Positives in GraphQL Mutation Detection

**Problem**: A query containing the string literal `"mutation"` is incorrectly identified as a mutation operation.

**Solution**: Strip comments and string values before detection:

```typescript
const normalized = query
  .replace(/#[^\n]*/g, " ") // Remove line comments
  .replace(/"""[\s\S]*?"""/g, " ") // Remove block strings
  .replace(/"(?:\\.|[^"\\])*"/g, " "); // Remove double-quoted strings
```

**You must write corresponding tests** to verify this behavior does not produce false positives.

### 6. TypeScript Compatibility with Environment Variable Type Overrides

**Problem**: Directly assigning `ctx.env.HTTP_JSON_ONLY = true` may cause a TypeScript error due to `readonly` types.

**Solution**: Use type assertion:

```typescript
(ctx.env as { HTTP_JSON_ONLY: boolean }).HTTP_JSON_ONLY = true;
```

---

## Summary: Recommended Test Matrix

The following table summarizes the test dimensions a mature MCP Server should cover:

| Dimension                                          | Test Method              | Priority |
| -------------------------------------------------- | ------------------------ | -------- |
| Protocol handshake (initialize / list)             | InMemoryTransport        | P0       |
| Tool Handler correctness                           | InMemoryTransport + stub | P0       |
| Schema validation / boundary inputs                | InMemoryTransport        | P0       |
| HTTP Session create/reuse/delete                   | Real HTTP server         | P0       |
| SSE connect/message/disconnect                     | Real HTTP server         | P1       |
| Session capacity limits                            | Real HTTP server         | P1       |
| Session rate limiting                              | Real HTTP server         | P1       |
| Session garbage collection                         | Real HTTP server         | P1       |
| Remote authentication (Bearer / Private-Token)     | Real HTTP server         | P1       |
| Dynamic API URL                                    | Real HTTP server         | P2       |
| Error handling (GitLabApiError / Error / unknown)  | InMemoryTransport        | P0       |
| Token redaction (glpat / ghp / JWT)                | InMemoryTransport        | P1       |
| Sensitive key redaction (password / authorization) | InMemoryTransport        | P1       |
| Safe mode vs full mode                             | InMemoryTransport        | P1       |
| Read-only mode tool filtering                      | InMemoryTransport        | P0       |
| Feature flags (wiki / pipeline / release)          | InMemoryTransport        | P1       |
| Tool allowlist / blocklist                         | InMemoryTransport        | P1       |
| GraphQL mutation detection and policy              | InMemoryTransport        | P1       |
| Agent Loop (ScriptedLLM)                           | InMemoryTransport        | P2       |
| Response truncation (maxBytes)                     | InMemoryTransport        | P2       |
| Health check endpoint                              | Real HTTP server         | P2       |
| Inspector CLI contract test                        | Inspector --cli          | P2       |
| Real LLM E2E                                       | Real LLM API             | P3       |

---

## References

- [MCP Official Specification](https://modelcontextprotocol.io/specification) (referenced version: 2025-11-25)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Inspector (including CLI mode)](https://github.com/modelcontextprotocol/inspector)
- [MCP Best Practices Guide](https://modelcontextprotocol.info/docs/best-practices/)
- [MCP Server E2E Testing Example](https://github.com/mkusaka/mcp-server-e2e-testing-example)
- [MCPcat Integration Testing Guide](https://mcpcat.io/guides/integration-tests-mcp-flows/)
- [MCPcat Unit Testing Guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/)
- [Stop Vibe-Testing Your MCP Server](https://www.jlowin.dev/blog/stop-vibe-testing-mcp-servers)
- [MCP Server Testing Tools Overview (Testomat.io)](https://testomat.io/blog/mcp-server-testing-tools/)
- [MCP Server Best Practices (MarkTechPost)](https://www.marktechpost.com/2025/07/23/7-mcp-server-best-practices-for-scalable-ai-integrations-in-2025/)
- [MCP Official Node.js Client Tutorial](https://modelcontextprotocol.io/tutorials/building-a-client)
