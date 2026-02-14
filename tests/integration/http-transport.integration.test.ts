/**
 * Integration tests for the HTTP transport layer.
 *
 * Uses the exported `setupMcpHttpApp()` factory with a test context,
 * starts a real HTTP server on port 0 (OS-assigned random port), and
 * tests endpoints with native `fetch`.
 *
 * Tests use HTTP_JSON_ONLY=true so responses are plain JSON (not SSE).
 */
import { createServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupMcpHttpApp, type SetupMcpHttpAppResult } from "../../src/http-app.js";
import { buildContext } from "./_helpers.js";
import type { AppContext } from "../../src/types/context.js";

/* ------------------------------------------------------------------ */
/*  Test harness                                                       */
/* ------------------------------------------------------------------ */

let httpServer: HttpServer;
let baseUrl: string;
let result: SetupMcpHttpAppResult;

function buildHttpContext(overrides?: Parameters<typeof buildContext>[0]): AppContext {
  const ctx = buildContext(overrides);
  // Enable JSON-only mode so we get JSON responses (not SSE)
  (ctx.env as { HTTP_JSON_ONLY: boolean }).HTTP_JSON_ONLY = true;
  return ctx;
}

function createTestApp(overrides?: Parameters<typeof buildContext>[0]) {
  const context = buildHttpContext(overrides);
  return setupMcpHttpApp({
    context,
    env: context.env,
    logger: context.logger
  });
}

/** Send a JSON-RPC request to /mcp and return the parsed response. */
async function mcpPost(
  body: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return { status: res.status, headers: res.headers, body: parsed };
}

/** Create a session by sending JSON-RPC initialize and return the session ID. */
async function initializeSession(): Promise<string> {
  const res = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test-client", version: "0.0.1" }
    }
  });

  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

/** Common fetch headers for /mcp requests. */
const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream"
};

/* ------------------------------------------------------------------ */
/*  Setup / teardown                                                   */
/* ------------------------------------------------------------------ */

beforeAll(async () => {
  result = createTestApp();

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
  for (const sessionId of result.sessions.keys()) {
    await result.closeSession(sessionId, "shutdown");
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("HTTP Transport Integration", () => {
  describe("health endpoint", () => {
    it("GET /healthz returns status ok, session counts, server name", async () => {
      const res = await fetch(`${baseUrl}/healthz`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.server).toBe("test-gitlab-mcp");
      expect(body.activeSessions).toBeDefined();
      expect(body.maxSessions).toBeDefined();
    });
  });

  describe("session creation", () => {
    it("POST /mcp with initialize returns Mcp-Session-Id header", async () => {
      const sessionId = await initializeSession();
      expect(sessionId).toBeTruthy();
      expect(typeof sessionId).toBe("string");
    });
  });

  describe("session reuse", () => {
    it("subsequent POST /mcp with same session ID succeeds", async () => {
      const sessionId = await initializeSession();

      // Send initialized notification (required by MCP protocol)
      await mcpPost(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { "mcp-session-id": sessionId }
      );

      // Now call tools/list with the session
      const res = await mcpPost(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { "mcp-session-id": sessionId }
      );

      expect(res.status).toBe(200);
      const body = res.body as { result?: { tools?: unknown[] } };
      expect(body.result).toBeDefined();
      expect(body.result!.tools).toBeDefined();
    });
  });

  describe("unknown session", () => {
    it("POST /mcp with invalid Mcp-Session-Id returns 404 + error code -32001", async () => {
      const res = await mcpPost(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { "mcp-session-id": "non-existent-session-id" }
      );

      expect(res.status).toBe(404);
      const body = res.body as { error?: { code?: number } };
      expect(body.error?.code).toBe(-32001);
    });
  });

  describe("non-POST without session", () => {
    it("GET /mcp without session returns 400 + error code -32000", async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "GET",
        headers: { Accept: "application/json, text/event-stream" }
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: number } };
      expect(body.error?.code).toBe(-32000);
    });
  });

  describe("health reflects sessions", () => {
    it("after creating session, /healthz shows activeSessions >= 1", async () => {
      await initializeSession();

      const res = await fetch(`${baseUrl}/healthz`);
      const body = (await res.json()) as { activeSessions: number };
      expect(body.activeSessions).toBeGreaterThanOrEqual(1);
    });
  });

  describe("tool call over HTTP", () => {
    it("calls health_check via HTTP and gets response content", async () => {
      const sessionId = await initializeSession();

      // Send initialized notification
      await mcpPost(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { "mcp-session-id": sessionId }
      );

      const res = await mcpPost(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "health_check", arguments: {} }
        },
        { "mcp-session-id": sessionId }
      );

      expect(res.status).toBe(200);
      const body = res.body as {
        result?: {
          content?: Array<{ type: string; text: string }>;
          structuredContent?: { status?: string };
        };
      };
      expect(body.result).toBeDefined();
      expect(body.result!.content).toBeDefined();

      const textContent = body.result!.content!.find((c) => c.type === "text");
      expect(textContent).toBeDefined();
      expect(textContent!.text).toContain("ok");
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Tests with separate server instances                               */
/* ------------------------------------------------------------------ */

describe("HTTP Transport - Session capacity", () => {
  it("returns 503 + error code -32002 when MAX_SESSIONS=1 and capacity reached", async () => {
    const ctx = buildHttpContext({ serverName: "capacity-test" });
    (ctx.env as { MAX_SESSIONS: number }).MAX_SESSIONS = 1;
    const cappedResult = setupMcpHttpApp({
      context: ctx,
      env: ctx.env,
      logger: ctx.logger
    });

    const server = createServer(cappedResult.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    const url = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";

    try {
      // Create first session — should succeed
      const first = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "cap-test", version: "0.0.1" }
          }
        })
      });
      expect(first.status).toBe(200);

      // Create second session — should be rejected
      const second = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "cap-test-2", version: "0.0.1" }
          }
        })
      });
      expect(second.status).toBe(503);
      const body = (await second.json()) as { error?: { code?: number } };
      expect(body.error?.code).toBe(-32002);
    } finally {
      for (const sessionId of cappedResult.sessions.keys()) {
        await cappedResult.closeSession(sessionId, "shutdown");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("HTTP Transport - Rate limiting", () => {
  it("returns 429 + error code -32003 when rate limit exceeded", async () => {
    const ctx = buildHttpContext({ serverName: "rate-test" });
    (ctx.env as { MAX_REQUESTS_PER_MINUTE: number }).MAX_REQUESTS_PER_MINUTE = 3;
    const rateLimitResult = setupMcpHttpApp({
      context: ctx,
      env: ctx.env,
      logger: ctx.logger
    });

    const server = createServer(rateLimitResult.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    const url = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";

    try {
      // Initialize session (request 1)
      const initRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "rate-test", version: "0.0.1" }
          }
        })
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id")!;

      // Send requests to exhaust rate limit (requests 2 and 3)
      for (let i = 0; i < 2; i++) {
        await fetch(`${url}/mcp`, {
          method: "POST",
          headers: {
            ...MCP_HEADERS,
            "mcp-session-id": sessionId
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized"
          })
        });
      }

      // Request 4 should be rate-limited
      const rateLimited = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          "mcp-session-id": sessionId
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/list",
          params: {}
        })
      });

      expect(rateLimited.status).toBe(429);
      const body = (await rateLimited.json()) as { error?: { code?: number } };
      expect(body.error?.code).toBe(-32003);
    } finally {
      for (const sessionId of rateLimitResult.sessions.keys()) {
        await rateLimitResult.closeSession(sessionId, "shutdown");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("HTTP Transport - Garbage collection", () => {
  it("removes expired sessions after garbageCollectSessions()", async () => {
    const ctx = buildHttpContext({ serverName: "gc-test" });
    (ctx.env as { SESSION_TIMEOUT_SECONDS: number }).SESSION_TIMEOUT_SECONDS = 0;
    const gcResult = setupMcpHttpApp({
      context: ctx,
      env: ctx.env,
      logger: ctx.logger
    });

    const server = createServer(gcResult.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    const url = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";

    try {
      // Create a session
      const initRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "gc-test", version: "0.0.1" }
          }
        })
      });
      expect(initRes.status).toBe(200);
      expect(gcResult.sessions.size).toBe(1);

      // Run garbage collection — session should be removed (timeout = 0)
      await gcResult.garbageCollectSessions();
      expect(gcResult.sessions.size).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
