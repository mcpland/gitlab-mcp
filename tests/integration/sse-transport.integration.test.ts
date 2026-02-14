/**
 * Integration tests for the SSE transport layer.
 *
 * Uses `setupMcpHttpApp` with `SSE=true`, real HTTP server on port 0.
 * Parses SSE event stream from `GET /sse` response.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupMcpHttpApp, type SetupMcpHttpAppResult } from "../../src/http-app.js";
import { buildContext } from "./_helpers.js";
import type { AppContext } from "../../src/types/context.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildSseContext(overrides?: Parameters<typeof buildContext>[0]): AppContext {
  const ctx = buildContext(overrides);
  (ctx.env as { SSE: boolean }).SSE = true;
  return ctx;
}

interface SseEvent {
  event?: string;
  data?: string;
}

/**
 * Parse SSE events from a fetch Response body stream.
 * Yields each complete event (terminated by a blank line).
 */
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
          if (line.startsWith("event: ")) {
            event.event = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            event.data = line.slice(6).trim();
          }
        }
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Connect to /sse and return the first event + an AbortController.
 * The caller is responsible for aborting when done.
 */
async function connectSse(
  baseUrl: string,
  controller?: AbortController
): Promise<{ event: SseEvent; controller: AbortController; response: Response }> {
  const ctrl = controller ?? new AbortController();
  const response = await fetch(`${baseUrl}/sse`, {
    headers: { Accept: "text/event-stream" },
    signal: ctrl.signal
  });

  const gen = parseSseEvents(response);
  const first = await gen.next();
  return { event: first.value as SseEvent, controller: ctrl, response };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("SSE Transport Integration", () => {
  let httpServer: HttpServer;
  let baseUrl: string;
  let result: SetupMcpHttpAppResult;

  beforeAll(async () => {
    const context = buildSseContext();
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
    for (const sessionId of result.sseSessions.keys()) {
      await result.closeSseSession(sessionId, "shutdown");
    }
    for (const sessionId of result.sessions.keys()) {
      await result.closeSession(sessionId, "shutdown");
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /sse returns SSE stream with endpoint event", async () => {
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
      controller.abort();
    }
  });

  it("POST /messages with valid sessionId succeeds", async () => {
    const controller = new AbortController();
    try {
      const { event } = await connectSse(baseUrl, controller);
      const messagesPath = event.data!;

      // The endpoint event data contains a relative path like /messages?sessionId=<uuid>
      const sessionUrl = `${baseUrl}${messagesPath}`;

      // Extract sessionId from the URL to verify it exists in sseSessions
      const parsedUrl = new URL(sessionUrl);
      const sessionId = parsedUrl.searchParams.get("sessionId")!;
      expect(result.sseSessions.has(sessionId)).toBe(true);

      const res = await fetch(sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "ping"
        })
      });

      // SSE transport handlePostMessage returns 202 Accepted for messages
      expect(res.status).toBe(202);
    } finally {
      controller.abort();
    }
  });

  it("POST /messages with missing sessionId returns 400", async () => {
    const res = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      })
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Missing sessionId");
  });

  it("POST /messages with invalid sessionId returns 400", async () => {
    const res = await fetch(`${baseUrl}/messages?sessionId=invalid-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {}
      })
    });

    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("No transport found");
  });

  it("/healthz shows sseEnabled: true", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sseEnabled).toBe(true);
  });

  it("/healthz shows activeSseSessions >= 1 after SSE connection", async () => {
    const controller = new AbortController();
    try {
      await connectSse(baseUrl, controller);

      const res = await fetch(`${baseUrl}/healthz`);
      const body = (await res.json()) as { activeSseSessions: number };
      expect(body.activeSseSessions).toBeGreaterThanOrEqual(1);
    } finally {
      controller.abort();
    }
  });
});

describe("SSE Transport - Capacity limit", () => {
  it("returns 503 when MAX_SESSIONS=1 and capacity reached", async () => {
    const ctx = buildSseContext({ serverName: "sse-cap-test" });
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

    const controller1 = new AbortController();
    try {
      // First SSE connection — should succeed
      await connectSse(url, controller1);
      expect(cappedResult.sseSessions.size).toBe(1);

      // Second SSE connection — should be rejected
      const res = await fetch(`${url}/sse`, {
        headers: { Accept: "text/event-stream" }
      });
      expect(res.status).toBe(503);
    } finally {
      controller1.abort();
      for (const sessionId of cappedResult.sseSessions.keys()) {
        await cappedResult.closeSseSession(sessionId, "shutdown");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("SSE Transport - Garbage collection", () => {
  it("removes expired SSE sessions after garbageCollectSessions()", async () => {
    const ctx = buildSseContext({ serverName: "sse-gc-test" });
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

    const controller = new AbortController();
    try {
      await connectSse(url, controller);
      expect(gcResult.sseSessions.size).toBe(1);

      // Run garbage collection — session should be removed (timeout = 0)
      await gcResult.garbageCollectSessions();
      expect(gcResult.sseSessions.size).toBe(0);
    } finally {
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

describe("SSE Transport - Client disconnect", () => {
  it("removes session from sseSessions on client disconnect", async () => {
    const ctx = buildSseContext({ serverName: "sse-disconnect-test" });
    const disconnectResult = setupMcpHttpApp({
      context: ctx,
      env: ctx.env,
      logger: ctx.logger
    });

    const server = createServer(disconnectResult.app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    const url = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";

    try {
      const controller = new AbortController();
      await connectSse(url, controller);
      expect(disconnectResult.sseSessions.size).toBe(1);

      // Abort the client connection
      controller.abort();

      // Poll until the close handler fires (up to 2 seconds)
      const deadline = Date.now() + 2000;
      while (disconnectResult.sseSessions.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(disconnectResult.sseSessions.size).toBe(0);
    } finally {
      for (const sessionId of disconnectResult.sseSessions.keys()) {
        await disconnectResult.closeSseSession(sessionId, "shutdown");
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
