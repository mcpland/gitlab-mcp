/**
 * Integration tests for the remote authorization flow.
 *
 * Uses `setupMcpHttpApp` with `REMOTE_AUTHORIZATION=true` and no
 * `GITLAB_PERSONAL_ACCESS_TOKEN`. Tests token parsing, dynamic API URL,
 * and 401/400 error responses.
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

function buildRemoteAuthContext(
  overrides?: Parameters<typeof buildContext>[0] & {
    enableDynamicApiUrl?: boolean;
  }
): AppContext {
  const ctx = buildContext({ ...overrides, token: null });
  (ctx.env as { REMOTE_AUTHORIZATION: boolean }).REMOTE_AUTHORIZATION = true;
  (ctx.env as { HTTP_JSON_ONLY: boolean }).HTTP_JSON_ONLY = true;
  if (overrides?.enableDynamicApiUrl) {
    (ctx.env as { ENABLE_DYNAMIC_API_URL: boolean }).ENABLE_DYNAMIC_API_URL = true;
  }
  return ctx;
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "remote-auth-test", version: "0.0.1" }
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Tests — basic remote auth                                          */
/* ------------------------------------------------------------------ */

describe("Remote Authorization Integration", () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  let result: SetupMcpHttpAppResult;

  beforeAll(async () => {
    const context = buildRemoteAuthContext();
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

  it("missing token returns 401 with error code -32010", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: MCP_HEADERS,
      body: initializeBody()
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32010);
    expect(body.error?.message).toContain("Missing remote authorization token");
  });

  it("Bearer token via Authorization header succeeds", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-remote-token"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  });

  it("Private-Token header succeeds", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "Private-Token": "test-private-token"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  });

  it("/healthz shows remoteAuthorization: true", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as { remoteAuthorization: boolean };
    expect(body.remoteAuthorization).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Tests — dynamic API URL                                            */
/* ------------------------------------------------------------------ */

describe("Remote Authorization - Dynamic API URL", () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  let result: SetupMcpHttpAppResult;

  beforeAll(async () => {
    const context = buildRemoteAuthContext({ enableDynamicApiUrl: true });
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

  it("missing API URL with ENABLE_DYNAMIC_API_URL returns 400 with error -32011", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-token"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32011);
    expect(body.error?.message).toContain("X-GitLab-API-URL");
  });

  it("dynamic API URL via X-GitLab-API-URL accepted", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-token",
        "X-GitLab-API-URL": "https://custom-gitlab.example.com/api/v4"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  });

  it("invalid X-GitLab-API-URL returns 500", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-token",
        "X-GitLab-API-URL": "not-a-url"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(500);
  });
});

/* ------------------------------------------------------------------ */
/*  Tests — auth context propagation                                   */
/* ------------------------------------------------------------------ */

describe("Remote Authorization - Auth propagation", () => {
  it("auth context propagated to tool handler via AsyncLocalStorage", async () => {
    const ctx = buildRemoteAuthContext();

    const result = setupMcpHttpApp({
      context: ctx,
      env: ctx.env,
      logger: ctx.logger
    });

    const server = createServer(result.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    const url = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";

    try {
      // Initialize session with Bearer token
      const initRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          Authorization: "Bearer my-secret-token"
        },
        body: initializeBody()
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id")!;

      // Verify the session's auth carries the token
      const session = result.sessions.get(sessionId);
      expect(session).toBeDefined();
      expect(session!.auth?.token).toBe("my-secret-token");
      expect(session!.auth?.header).toBe("authorization");
    } finally {
      for (const sessionId of result.sessions.keys()) {
        await result.closeSession(sessionId, "shutdown");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
