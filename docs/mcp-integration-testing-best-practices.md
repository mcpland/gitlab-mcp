# MCP Server Integration Testing Best Practices (JavaScript / TypeScript)

> This guide is for teams building MCP servers in the Node.js / TypeScript ecosystem. It focuses on a **deterministic, automatable, layered** integration testing strategy.
>
> Baseline: MCP specification **2025-11-25**. The guide explicitly distinguishes **Streamable HTTP (current)** from **HTTP+SSE (legacy compatibility)**.
>
> Version note: as of early 2026, the TypeScript SDK is still in a v1 → v2 transition period. Many production systems still run v1, while v2 is introducing package splits and API changes.
>
> Scope note: this document summarizes methodology and implementation patterns. Snippets, env vars, file paths, and commands are examples and should be adapted to your repository.

---

## Table of Contents

- [Why MCP Servers Need Integration Tests](#why-mcp-servers-need-integration-tests)
- [Testing Pyramid for MCP](#testing-pyramid-for-mcp)
- [Layer 0: Design for Testability (Server Factory + Dependency Injection)](#layer-0-design-for-testability-server-factory--dependency-injection)
- [Layer 1: InMemoryTransport Protocol-Level Integration Tests (P0 Core)](#layer-1-inmemorytransport-protocol-level-integration-tests-p0-core)
  - [Core Scaffold: buildContext + createLinkedPair](#core-scaffold-buildcontext--createlinkedpair)
  - [Pattern 1: Capabilities and List Contracts (tools/resources/prompts/list)](#pattern-1-capabilities-and-list-contracts-toolsresourcespromptslist)
  - [Pattern 2: Tool Handler End-to-End Validation (stub external dependencies)](#pattern-2-tool-handler-end-to-end-validation-stub-external-dependencies)
  - [Pattern 3: Schema Validation and Boundary Inputs](#pattern-3-schema-validation-and-boundary-inputs)
  - [Pattern 4: Minimal Coverage for Bidirectional Requests (Sampling/Elicitation)](#pattern-4-minimal-coverage-for-bidirectional-requests-samplingelicitation)
- [Layer 2: Streamable HTTP Transport Integration Tests (P0/P1)](#layer-2-streamable-http-transport-integration-tests-p0p1)
  - [Spec Checklist You Must Align With (2025-11-25)](#spec-checklist-you-must-align-with-2025-11-25)
  - [HTTP Test Harness: Port 0 + Isolated Server Instances](#http-test-harness-port-0--isolated-server-instances)
  - [Must-Test Cases: Session, 404 Reinitialize, DELETE, Protocol Version Header](#must-test-cases-session-404-reinitialize-delete-protocol-version-header)
  - [SSE Stream Tests (GET/POST SSE on Streamable HTTP)](#sse-stream-tests-getpost-sse-on-streamable-http)
- [Layer 2.5: Legacy HTTP+SSE Compatibility Tests (Only if Needed)](#layer-25-legacy-httpsse-compatibility-tests-only-if-needed)
- [Layer 3: Security / Auth / Policy Tests (P0/P1)](#layer-3-security--auth--policy-tests-p0p1)
  - [Origin/Host Protection (DNS Rebinding)](#originhost-protection-dns-rebinding)
  - [OAuth/Authorization (Resource Metadata Discovery)](#oauthauthorization-resource-metadata-discovery)
  - [Error Handling and Secret Redaction](#error-handling-and-secret-redaction)
  - [Policy Combinatorics: Read-Only, Allowlists, Feature Flags](#policy-combinatorics-read-only-allowlists-feature-flags)
- [Layer 4: Conformance Testing (Strongly Recommended)](#layer-4-conformance-testing-strongly-recommended)
- [Layer 5: Agent Loop Integration Tests (ScriptedLLM + Small Real-LLM Smoke)](#layer-5-agent-loop-integration-tests-scriptedllm--small-real-llm-smoke)
- [Layer 6: Inspector CLI Black-Box Contract Tests (Pre/Post Deployment)](#layer-6-inspector-cli-black-box-contract-tests-prepost-deployment)
- [CI/CD Layered Execution Strategy](#cicd-layered-execution-strategy)
- [Common Pitfalls and Fixes (Updated for 2025-11-25)](#common-pitfalls-and-fixes-updated-for-2025-11-25)
- [Recommended Test Matrix (Copy/Paste)](#recommended-test-matrix-copypaste)
- [References and Compatibility Notes](#references-and-compatibility-notes)

---

## Why MCP Servers Need Integration Tests

An MCP server is not a standard HTTP API. Complexity comes from the combination of protocol mechanics, session behavior, bidirectional messaging, and security boundaries.

1. **Stateful sessions over HTTP**: initialization can return `MCP-Session-Id`; subsequent requests must carry it. When a session expires, the server should return `404`, and the client should re-initialize.
2. **Multiple transports**: the spec defines stdio and Streamable HTTP. Streamable HTTP uses a single endpoint that can support both `POST` and `GET` (optional SSE stream).
3. **Bidirectional messaging**: servers can send notifications/requests over SSE. Disconnection is not cancellation; cancellation requires an explicit cancel notification.
4. **Explicit security requirements**: Streamable HTTP should validate `Origin` to mitigate DNS rebinding. Local deployments should typically bind to `127.0.0.1`, and auth should be implemented where required.
5. **Authorization is more than Bearer header plumbing**: the spec defines OAuth-based discovery and flow, including Protected Resource Metadata discovery.

Because of this, unit tests alone cannot cover full interaction behavior. Integration tests should use **real MCP clients + real MCP servers + real/simulated transports** so results are reproducible, assertable, and CI-friendly.

---

## Testing Pyramid for MCP

```text
                    ┌───────────────────┐
                    │  Real LLM Smoke   │  ← small, nightly
                    └─────────┬─────────┘
                              │
                ┌─────────────┴─────────────┐
                │  Agent Loop (ScriptedLLM) │  ← nightly / small PR subset
                └─────────────┬─────────────┘
                              │
             ┌────────────────┴────────────────┐
             │ Conformance (Spec Compliance)   │  ← nightly / pre-release
             └────────────────┬────────────────┘
                              │
      ┌───────────────────────┴───────────────────────┐
      │ Streamable HTTP + Session + SSE integration    │  ← every PR (P0/P1)
      └───────────────────────┬───────────────────────┘
                              │
    ┌─────────────────────────┴─────────────────────────┐
    │ InMemoryTransport protocol-level integration       │  ← every commit (P0)
    └───────────────────────────────────────────────────┘
```

Principle: lower layers should be broader, faster, and more deterministic. Higher layers should be smaller and smoke-oriented.

---

## Layer 0: Design for Testability (Server Factory + Dependency Injection)

Whether integration testing is practical is mostly determined by server architecture.

### Core requirements

- **Server constructor should be a pure factory**: `createMcpServer(context)` depends only on `context`. Avoid direct top-level reads of `process.env`, DB connections, or network calls.
- **Context should be complete**: include env, logger, external API clients, policy engine, formatters, and optionally clock/random providers.
- **Defaults must be usable**: `buildContext()` should provide complete defaults, and tests should override only deltas.
- **Time/random should be controllable**: session IDs, expiry handling, and retries become stable when time/random sources are injectable.

---

## Layer 1: InMemoryTransport Protocol-Level Integration Tests (P0 Core)

Goal: avoid opening ports or spawning processes. Use real MCP client ↔ server lifecycle (`initialize` / `list` / `call`) in one process.

### Core Scaffold: buildContext + createLinkedPair

```ts
// tests/integration/_helpers.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../src/server/createMcpServer.js";

export function buildContext(overrides?: Partial<AppContext>): AppContext {
  return {
    env: {
      READ_ONLY_MODE: false,
      ...overrides?.env
    },
    logger: overrides?.logger ?? {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    services: {
      ...overrides?.services
    },
    policy: overrides?.policy ?? new ToolPolicyEngine(),
    formatter: overrides?.formatter ?? new OutputFormatter()
  };
}

export async function createLinkedPair(context: AppContext) {
  const server = createMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client(
    { name: "integration-test-client", version: "0.0.1" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  return { client, server, clientTransport, serverTransport, context };
}
```

Always close transports using `try/finally`, even if one side may cascade-close in current implementation.

### Pattern 1: Capabilities and List Contracts (tools/resources/prompts/list)

Do not test tools only. A mature MCP server often exposes tools, resources, and prompts. The list contract is a first-order external API.

```ts
describe("Contract: listTools()", () => {
  it("exposes expected core tools by default", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(buildContext());

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(names).toContain("health_check");
      expect(names).toContain("my_readonly_tool");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("hides write tools in read-only mode", async () => {
    const ctx = buildContext({ env: { READ_ONLY_MODE: true } as any });
    const { client, clientTransport, serverTransport } = await createLinkedPair(ctx);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(names).not.toContain("create_issue");
      expect(names).toContain("health_check");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
```

Recommended assertion style:

- Assert presence/absence of tool names (stable).
- Avoid asserting full text descriptions (high-churn).

### Pattern 2: Tool Handler End-to-End Validation (stub external dependencies)

Validate at least three aspects:

1. Correct dependency call with correct parameters.
2. Correct MCP tool result shape (`content[]` and optional `structuredContent`).
3. Correct error-path behavior.

```ts
describe("Tool handler: get_project", () => {
  it("forwards project_id to dependency", async () => {
    const getProject = vi.fn().mockResolvedValue({ id: 42, name: "alpha" });

    const ctx = buildContext({
      services: { git: { getProject } } as any
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(ctx);

    try {
      const result = await client.callTool({
        name: "get_project",
        arguments: { project_id: "group/alpha" }
      });

      expect(getProject).toHaveBeenCalledWith("group/alpha");
      expect(result.isError).toBeFalsy();

      const text = (result.content as any[]).find((c) => c.type === "text")?.text ?? "";
      expect(text).toContain("alpha");
      expect(result.structuredContent).toMatchObject({ id: 42, name: "alpha" });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
```

Practical rule: stub only what the test should use. Unexpected dependency usage should fail loudly.

### Pattern 3: Schema Validation and Boundary Inputs

Most MCP servers use schema validation (often Zod). Invalid input should be treated as a first-class test target:

- Missing/extra fields.
- Type mismatches.
- Invalid enum values.
- `null` / `undefined` semantics.

```ts
describe("Schema validation", () => {
  it("returns tool-level error for type mismatch", async () => {
    const ctx = buildContext({ services: { git: { listProjects: vi.fn() } } as any });
    const { client, clientTransport, serverTransport } = await createLinkedPair(ctx);

    try {
      const result = await client.callTool({
        name: "list_projects",
        arguments: { page: "not-a-number" } as any
      });

      expect(result.isError).toBe(true);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
```

If your implementation maps validation failures to protocol errors (`-32602 InvalidParams`) instead of tool-level errors, that can also be valid. The key is consistency with client expectations.

### Pattern 4: Minimal Coverage for Bidirectional Requests (Sampling/Elicitation)

If your server uses server-initiated requests (for example, sampling/elicitation), add a minimal closed-loop test:

- Register client-side handlers with deterministic responses.
- Verify server behavior continues correctly after handler responses.

---

## Layer 2: Streamable HTTP Transport Integration Tests (P0/P1)

InMemory tests are fast but skip critical reality: wire serialization, HTTP headers, session headers, SSE behavior, and origin checks.

### Spec Checklist You Must Align With (2025-11-25)

- **Single MCP endpoint** supports both `POST` and `GET`.
- **POST** requires client `Accept: application/json, text/event-stream`.
- **POST body** must be a single JSON-RPC message (not batch array in strict mode if your stack enforces that).
- **GET** opens SSE stream, or server may return `405` if SSE is not supported.
- **Origin security** should reject invalid origins with `403`.
- **Session behavior**: when session IDs are enabled, post-init requests must include `MCP-Session-Id`.
- **Protocol version header** should be validated for post-init requests.

### HTTP Test Harness: Port 0 + Isolated Server Instances

Never share a stateful server instance across tests involving session/rate-limit/connection state.

```ts
import { createServer, type Server as HttpServer } from "node:http";

let httpServer: HttpServer;
let baseUrl: string;

beforeEach(async () => {
  const app = buildYourExpressOrHonoApp();
  httpServer = createServer(app);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = httpServer.address();
  if (typeof addr === "object" && addr?.port) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("Failed to bind test port");
  }
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});
```

### Must-Test Cases: Session, 404 Reinitialize, DELETE, Protocol Version Header

#### 1) Initialization returns `MCP-Session-Id` (stateful mode)

```ts
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream"
};

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "itest", version: "0.0.1" }
    }
  });
}

it("returns MCP-Session-Id during initialize", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: initializeBody()
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("MCP-Session-Id")).toBeTruthy();
});
```

#### 2) Post-init requests require `MCP-Session-Id` and valid protocol version

```ts
it("requires session and protocol headers post-init", async () => {
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: initializeBody()
  });
  const sessionId = initRes.headers.get("MCP-Session-Id")!;

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": "2025-11-25"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });

  expect(res.status).toBe(200);
});
```

#### 3) Invalid protocol version returns `400`

```ts
it("returns 400 for invalid MCP-Protocol-Version", async () => {
  const initRes = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: initializeBody()
  });
  const sessionId = initRes.headers.get("MCP-Session-Id")!;

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": "invalid-version"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  });

  expect(res.status).toBe(400);
});
```

#### 4) Session termination and re-initialization (`404` behavior)

If your server expires/terminates sessions, requests with stale session IDs should return `404`, and client should re-initialize without sending old session ID.

#### 5) DELETE semantics (`200` or `405`)

The server may support explicit session termination via `DELETE`, or may return `405`.

### SSE Stream Tests (GET/POST SSE on Streamable HTTP)

In Streamable HTTP, SSE happens on the **same endpoint**:

- POST response can be `text/event-stream`.
- GET may open a standalone SSE channel for notifications.

#### 1) `GET /mcp` should be SSE (`200`) or unsupported (`405`)

```ts
it("GET /mcp returns SSE or 405", async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "GET",
    headers: { Accept: "text/event-stream" }
  });

  const ct = res.headers.get("content-type") ?? "";
  expect([200, 405]).toContain(res.status);
  if (res.status === 200) {
    expect(ct).toContain("text/event-stream");
  }
});
```

#### 2) JSON-only mode should reject GET (`405`)

If you explicitly enable JSON-only response mode, test that GET is rejected as expected.

#### 3) SSE disconnect/reconnect behavior

Avoid fixed sleeps. Prefer deadline + polling assertions when testing reconnect behavior.

---

## Layer 2.5: Legacy HTTP+SSE Compatibility Tests (Only if Needed)

Streamable HTTP replaces legacy HTTP+SSE. If you still need old-client compatibility:

- Clearly label it as **legacy transport**.
- Keep minimal black-box tests for old endpoints.
- Implement new capabilities only on Streamable HTTP, not legacy.

---

## Layer 3: Security / Auth / Policy Tests (P0/P1)

### Origin/Host Protection (DNS Rebinding)

Recommended cases:

- Missing `Origin` (allow/deny based on policy, but keep behavior consistent).
- Invalid `Origin` outside allowlist → `403`.
- Invalid `Host` when host validation is enabled.

### OAuth/Authorization (Resource Metadata Discovery)

If your HTTP transport supports OAuth-compliant authorization, minimally test:

- Unauthorized request returns `401` with expected auth challenge information.
- Optional scope challenge in auth response.
- Resource metadata endpoint exists and includes expected authorization server metadata.

If you use a private bearer token model instead of full OAuth discovery, document and test that explicitly as a custom mode.

### Error Handling and Secret Redaction

Differentiate:

- **Tool-level error**: request reached tool; `result.isError === true`.
- **Protocol-level error**: request itself failed; client gets protocol/transport exception.

Must-test:

- Stable error shape mapping.
- No leakage of sensitive values (`Authorization`, `password`, `token`, cookies).
- Security mode vs debug mode output differences.

### Policy Combinatorics: Read-Only, Allowlists, Feature Flags

Policy regressions are common.

Recommended approach:

- Layer 1: contract tests on `listTools()` for key policy combinations.
- Layer 2: a small number of end-to-end HTTP tests combining session + policy.

---

## Layer 4: Conformance Testing (Strongly Recommended)

Conformance tests catch protocol drift during spec and SDK upgrades.

```bash
# Run server conformance scenarios against a running server
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp

# Run one scenario only
npx @modelcontextprotocol/conformance server --url http://localhost:3000/mcp --scenario server-initialize

# List all scenarios
npx @modelcontextprotocol/conformance list
```

Recommended usage:

- Nightly: full conformance suite.
- Pre-release: blocking gate.

---

## Layer 5: Agent Loop Integration Tests (ScriptedLLM + Small Real-LLM Smoke)

Core principle: assert deterministic signals (tool sequence/arguments), not natural-language exact text.

### ScriptedLLM mode (recommended)

- Drive agents with pre-scripted LLM responses.
- Assert called tools, arguments, and key entities in final output.

### Real-LLM smoke (small)

- Keep to 1–3 scenarios.
- Use weak assertions (non-empty output, successful basic tool call).
- Run nightly or on-demand only.

---

## Layer 6: Inspector CLI Black-Box Contract Tests (Pre/Post Deployment)

Inspector can be used as user-perspective black-box validation.

- Local build artifact: `node dist/index.js` (stdio).
- Remote deployment: `https://your-domain/mcp` (Streamable HTTP).

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
```

---

## CI/CD Layered Execution Strategy

| Trigger           | Test Layers                                 | Goal                                                            |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Every commit / PR | Layer 1 (InMemory)                          | P0 contract: tools/handlers/schema/policy                       |
| Every PR          | Layer 2 (HTTP)                              | P0/P1: session, 404 reinitialize, protocol headers, GET SSE/405 |
| Nightly           | Layer 4 (Conformance)                       | Spec compliance and upgrade early warning                       |
| Nightly           | Layer 5 (Agent loop + small real LLM smoke) | Real usage path smoke checks                                    |
| Pre-release       | Layer 6 (Inspector + deployment black-box)  | Release acceptance gate                                         |

---

## Common Pitfalls and Fixes (Updated for 2025-11-25)

1. Treating legacy HTTP+SSE as the current protocol model.

- Fix: use Streamable HTTP as primary; isolate legacy compatibility.

2. Sending JSON-RPC batch arrays in POST bodies.

- Fix: enforce single-message payloads where required by your server/profile.

3. Forgetting `MCP-Protocol-Version` / `MCP-Session-Id` in post-init requests.

- Fix: test valid, missing, and invalid header combinations.

4. Missing Origin checks (DNS rebinding risk).

- Fix: add origin/host allowlist tests and default-safe binding strategy.

5. Incorrect body handling in HTTP middleware.

- Fix: ensure transport receives request body in the expected form.

6. Misclassifying SSE disconnect as request cancellation.

- Fix: model cancellation explicitly and test cancellation semantics directly.

7. Multi-replica session stickiness issues.

- Fix: sticky sessions or external session store for stateful transport behavior.

---

## Recommended Test Matrix (Copy/Paste)

| Dimension                                             | Method          | Priority |
| ----------------------------------------------------- | --------------- | -------- |
| initialize / lifecycle                                | InMemory + HTTP | P0       |
| tools/resources/prompts list contracts                | InMemory        | P0       |
| tool handler correctness with stubs                   | InMemory        | P0       |
| schema validation (bad input)                         | InMemory        | P0       |
| Streamable HTTP accept/headers/status                 | HTTP            | P0       |
| `MCP-Session-Id`: create/reuse/terminate/reinitialize | HTTP            | P0       |
| `MCP-Protocol-Version`: missing/invalid/valid         | HTTP            | P0       |
| GET behavior: SSE or 405                              | HTTP            | P1       |
| Origin/Host validation                                | HTTP            | P0/P1    |
| OAuth challenge + resource metadata                   | HTTP            | P1       |
| SSE reconnect (`retry` / `Last-Event-ID`)             | HTTP            | P2       |
| conformance suite                                     | CLI             | P1       |
| inspector black-box on artifacts                      | CLI             | P2       |
| agent loop (ScriptedLLM)                              | InMemory        | P2       |
| real LLM smoke                                        | external API    | P3       |

---

## References and Compatibility Notes

- MCP Specification 2025-11-25: transports, sessions, protocol version behavior.
- MCP Specification 2025-11-25: authorization and Protected Resource Metadata.
- MCP Conformance tooling.
- MCP Inspector documentation.
- TypeScript SDK migration notes (v1 to v2).
- TypeScript SDK server/client guides for Streamable HTTP behavior.

---
