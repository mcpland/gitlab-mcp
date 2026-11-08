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

let gitLabServer: HttpServer;
let gitLabApiUrl: string;

/** Tokens named alice-* and bob-* belong to two different GitLab users. */
function userForToken(token: string): Record<string, unknown> {
  if (token.startsWith("alice-")) {
    return { id: 101, username: "alice" };
  }
  if (token.startsWith("bob-")) {
    return { id: 202, username: "bob" };
  }
  return {};
}

beforeAll(async () => {
  gitLabServer = createServer((req, res) => {
    if (req.url === "/api/v4/user") {
      const token =
        req.headers["private-token"] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const valid = typeof token === "string" && !token.startsWith("invalid-");
      res.statusCode = valid ? 200 : 401;
      res.setHeader("content-type", "application/json");
      res.end(valid ? JSON.stringify(userForToken(token)) : "unauthorized");
      return;
    }

    if (req.url === "/api/v4/job") {
      const token = req.headers["job-token"];
      const valid = typeof token === "string" && !token.startsWith("invalid-");
      res.statusCode = valid ? 200 : 401;
      res.end(valid ? "{}" : "unauthorized");
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));
  const address = gitLabServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected GitLab validation server address");
  }
  gitLabApiUrl = `http://127.0.0.1:${address.port}/api/v4`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      gitLabServer.close((error) => (error ? reject(error) : resolve()));
    })
);

function buildRemoteAuthContext(
  overrides?: Parameters<typeof buildContext>[0] & {
    enableDynamicApiUrl?: boolean;
  }
): AppContext {
  const ctx = buildContext({ ...overrides, token: null });
  ctx.env.GITLAB_API_URL = gitLabApiUrl;
  ctx.env.GITLAB_API_URLS = [gitLabApiUrl];
  (ctx.env as { REMOTE_AUTHORIZATION: boolean }).REMOTE_AUTHORIZATION = true;
  (ctx.env as { HTTP_JSON_ONLY: boolean }).HTTP_JSON_ONLY = true;
  ctx.allowLocalFileTools = false;
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

  it("Job-Token header succeeds", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "Job-Token": "test-job-token"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
  });

  it("rejects an upstream-invalid token before creating a session", async () => {
    const sessionsBefore = result.sessions.size;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "Private-Token": "invalid-private-token"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32018);
    expect(body.error?.message).toContain("rejected by the configured GitLab API");
    expect(result.sessions.size).toBe(sessionsBefore);
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
        "X-GitLab-API-URL": `${gitLabApiUrl}/untrusted/request/path`
      },
      body: initializeBody()
    });

    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    expect(result.sessions.get(sessionId!)?.auth?.apiUrl).toBe(gitLabApiUrl);
  });

  it("rejects an unlisted dynamic API URL host", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-token",
        "X-GitLab-API-URL": "https://attacker.example.com/api/v4"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32012);
    expect(body.error?.message).toContain("host is not allowed");
  });

  it("invalid X-GitLab-API-URL returns structured 400 JSON-RPC error", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-token",
        "X-GitLab-API-URL": "not-a-url"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32012);
    expect(body.error?.message).toContain("Invalid x-gitlab-api-url header");
  });

  it("rejects non-http X-GitLab-API-URL protocols", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        Authorization: "Bearer test-token",
        "X-GitLab-API-URL": "ftp://custom-gitlab.example.com/api/v4"
      },
      body: initializeBody()
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32012);
    expect(body.error?.message).toContain("Invalid x-gitlab-api-url header");
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

  it("stores job-token auth mode in session context", async () => {
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
      const initRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          "Job-Token": "job-token-123"
        },
        body: initializeBody()
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id")!;

      const session = result.sessions.get(sessionId);
      expect(session).toBeDefined();
      expect(session!.auth?.token).toBe("job-token-123");
      expect(session!.auth?.header).toBe("job-token");
    } finally {
      for (const sessionId of result.sessions.keys()) {
        await result.closeSession(sessionId, "shutdown");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("prefers Private-Token over Job-Token and Bearer headers", async () => {
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
      const initRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          ...MCP_HEADERS,
          Authorization: "Bearer bearer-token-123",
          "Job-Token": "job-token-123",
          "Private-Token": "private-token-123"
        },
        body: initializeBody()
      });
      expect(initRes.status).toBe(200);
      const sessionId = initRes.headers.get("mcp-session-id")!;

      const session = result.sessions.get(sessionId);
      expect(session).toBeDefined();
      expect(session!.auth?.token).toBe("private-token-123");
      expect(session!.auth?.header).toBe("private-token");
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

/* ------------------------------------------------------------------ */
/*  Tests — session ownership                                          */
/* ------------------------------------------------------------------ */

describe("Remote Authorization - session ownership", () => {
  async function startRemoteAuthServer() {
    const ctx = buildRemoteAuthContext();
    const result = setupMcpHttpApp({ context: ctx, env: ctx.env, logger: ctx.logger });
    const server = createServer(result.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const url = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";

    return {
      ctx,
      result,
      url,
      async close() {
        for (const sessionId of result.sessions.keys()) {
          await result.closeSession(sessionId, "shutdown");
        }
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    };
  }

  async function initialize(url: string, headers: Record<string, string>): Promise<string> {
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, ...headers },
      body: initializeBody()
    });
    expect(res.status).toBe(200);
    return res.headers.get("mcp-session-id")!;
  }

  function ping(url: string, sessionId: string, headers: Record<string, string>) {
    return fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        ...MCP_HEADERS,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
        ...headers
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
    });
  }

  it("treats another user's credential as an unknown session", async () => {
    const running = await startRemoteAuthServer();
    try {
      const sessionId = await initialize(running.url, { "Private-Token": "alice-token-1" });

      const hijack = await ping(running.url, sessionId, { "Private-Token": "bob-token-1" });
      expect(hijack.status).toBe(404);
      const body = (await hijack.json()) as { error?: { message?: string } };
      expect(body.error?.message).toBe("Unknown session");
      expect(body.error?.message).not.toContain(sessionId);

      const session = running.result.sessions.get(sessionId);
      expect(session?.auth?.token).toBe("alice-token-1");

      for (const method of ["GET", "DELETE"]) {
        const res = await fetch(`${running.url}/mcp`, {
          method,
          headers: {
            Accept: "application/json, text/event-stream",
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-03-26",
            "Private-Token": "bob-token-1"
          }
        });
        expect(res.status, method).toBe(404);
        await res.body?.cancel();
      }
      expect(running.result.sessions.has(sessionId)).toBe(true);
    } finally {
      await running.close();
    }
  });

  it("accepts a rotated token of the same user and stores it", async () => {
    const running = await startRemoteAuthServer();
    try {
      const sessionId = await initialize(running.url, { "Private-Token": "alice-token-1" });

      const res = await ping(running.url, sessionId, { Authorization: "Bearer alice-token-2" });
      expect(res.status).toBe(200);
      expect(running.result.sessions.get(sessionId)?.auth?.token).toBe("alice-token-2");
    } finally {
      await running.close();
    }
  });

  it("binds sessions to the exact token when GitLab returns no user id", async () => {
    const running = await startRemoteAuthServer();
    try {
      const sessionId = await initialize(running.url, { "Private-Token": "anonymous-a" });

      expect((await ping(running.url, sessionId, { "Private-Token": "anonymous-b" })).status).toBe(
        404
      );
      expect((await ping(running.url, sessionId, { "Private-Token": "anonymous-a" })).status).toBe(
        200
      );
    } finally {
      await running.close();
    }
  });

  it("logs a digest instead of the raw session id", async () => {
    const running = await startRemoteAuthServer();
    try {
      const sessionId = await initialize(running.url, { "Private-Token": "alice-token-1" });
      const info = running.ctx.logger.info as unknown as { mock: { calls: unknown[][] } };
      const serialized = JSON.stringify(info.mock.calls);

      expect(serialized).toContain("MCP session initialized");
      expect(serialized).not.toContain(sessionId);
      expect(serialized).toMatch(/sha256:[0-9a-f]{12}/u);
    } finally {
      await running.close();
    }
  });
});
