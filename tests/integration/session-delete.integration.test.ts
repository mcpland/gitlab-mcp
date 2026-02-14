/**
 * Integration tests for HTTP DELETE /mcp session closure.
 *
 * Uses `setupMcpHttpApp` with HTTP_JSON_ONLY=true, real HTTP server on port 0.
 * Tests the DELETE /mcp endpoint for closing sessions.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupMcpHttpApp, type SetupMcpHttpAppResult } from "../../src/http-app.js";
import { buildContext } from "./_helpers.js";
import type { AppContext } from "../../src/types/context.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream"
};

function buildHttpContext(overrides?: Parameters<typeof buildContext>[0]): AppContext {
  const ctx = buildContext(overrides);
  (ctx.env as { HTTP_JSON_ONLY: boolean }).HTTP_JSON_ONLY = true;
  return ctx;
}

async function initializeSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "delete-test-client", version: "0.0.1" }
      }
    })
  });

  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("Session DELETE Integration", () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  let result: SetupMcpHttpAppResult;

  beforeAll(async () => {
    const context = buildHttpContext({ serverName: "delete-test" });
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
    for (const sessionId of result.sessions.keys()) {
      await result.closeSession(sessionId, "shutdown");
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("DELETE /mcp with valid session closes it", async () => {
    const sessionId = await initializeSession(baseUrl);
    expect(result.sessions.has(sessionId)).toBe(true);

    const sizeBefore = result.sessions.size;

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": sessionId
      }
    });

    // StreamableHTTPServerTransport returns 200 on successful close
    expect(res.status).toBe(200);
    expect(result.sessions.size).toBeLessThan(sizeBefore);
  });

  it("after DELETE, POST with same session returns 404", async () => {
    const sessionId = await initializeSession(baseUrl);

    // Delete the session
    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": sessionId
      }
    });

    // Try to use the deleted session
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32001);
  });

  it("DELETE without Mcp-Session-Id returns 400", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: MCP_HEADERS
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32000);
  });

  it("DELETE with unknown session ID returns 404", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": "non-existent-session-id"
      }
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32001);
  });

  it("/healthz activeSessions decreases after DELETE", async () => {
    const sessionId = await initializeSession(baseUrl);

    const beforeRes = await fetch(`${baseUrl}/healthz`);
    const beforeBody = (await beforeRes.json()) as { activeSessions: number };
    const before = beforeBody.activeSessions;

    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": sessionId
      }
    });

    const afterRes = await fetch(`${baseUrl}/healthz`);
    const afterBody = (await afterRes.json()) as { activeSessions: number };
    expect(afterBody.activeSessions).toBeLessThan(before);
  });
});
