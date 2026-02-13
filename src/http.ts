import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { env } from "./config/env.js";
import { runWithSessionAuth, type SessionAuth } from "./lib/auth-context.js";
import { GitLabClient } from "./lib/gitlab-client.js";
import { logger } from "./lib/logger.js";
import { configureNetworkRuntime } from "./lib/network.js";
import { OutputFormatter } from "./lib/output.js";
import { ToolPolicyEngine } from "./lib/policy.js";
import { GitLabRequestRuntime } from "./lib/request-runtime.js";
import { hasReachedSessionCapacity } from "./lib/session-capacity.js";
import { createMcpServer } from "./server/build-server.js";
import type { AppContext } from "./types/context.js";

interface SessionState {
  sessionId?: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastAccessAt: number;
  queue: Promise<void>;
  activeRequests: number;
  closed: boolean;
  auth?: SessionAuth;
  rateLimit: {
    windowStart: number;
    count: number;
  };
}

interface SseSessionState {
  sessionId: string;
  server: McpServer;
  transport: SSEServerTransport;
  lastAccessAt: number;
  closed: boolean;
}

const requestRuntime = new GitLabRequestRuntime(env, logger);
configureNetworkRuntime(env, logger);

const context: AppContext = {
  env,
  logger,
  gitlab: new GitLabClient(env.GITLAB_API_URL, env.GITLAB_PERSONAL_ACCESS_TOKEN, {
    apiUrls: env.GITLAB_API_URLS,
    timeoutMs: env.GITLAB_HTTP_TIMEOUT_MS,
    beforeRequest: (requestContext) => requestRuntime.beforeRequest(requestContext)
  }),
  policy: new ToolPolicyEngine({
    readOnlyMode: env.GITLAB_READ_ONLY_MODE,
    allowedTools: env.GITLAB_ALLOWED_TOOLS,
    deniedToolsRegex: env.GITLAB_DENIED_TOOLS_REGEX
      ? new RegExp(env.GITLAB_DENIED_TOOLS_REGEX)
      : undefined,
    enabledFeatures: {
      wiki: env.USE_GITLAB_WIKI,
      milestone: env.USE_MILESTONE,
      pipeline: env.USE_PIPELINE,
      release: env.USE_RELEASE
    }
  }),
  formatter: new OutputFormatter({
    responseMode: env.GITLAB_RESPONSE_MODE,
    maxBytes: env.GITLAB_MAX_RESPONSE_BYTES
  })
};

const app = createMcpExpressApp({ host: env.HTTP_HOST });
app.use(express.json({ limit: "2mb" }));

const sessions = new Map<string, SessionState>();
const pendingSessions = new Set<SessionState>();
const sseSessions = new Map<string, SseSessionState>();

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    status: sessions.size + sseSessions.size >= env.MAX_SESSIONS ? "degraded" : "ok",
    server: env.MCP_SERVER_NAME,
    activeSessions: sessions.size,
    activeSseSessions: sseSessions.size,
    pendingSessions: pendingSessions.size,
    maxSessions: env.MAX_SESSIONS,
    remoteAuthorization: env.REMOTE_AUTHORIZATION,
    readOnlyMode: env.GITLAB_READ_ONLY_MODE,
    sseEnabled: env.SSE
  });
});

if (env.SSE) {
  app.get("/sse", async (req, res) => {
    let sessionId: string | undefined;
    try {
      const parsedAuth = parseRequestAuth(req);
      const fallbackToken = env.REMOTE_AUTHORIZATION ? undefined : env.GITLAB_PERSONAL_ACCESS_TOKEN;

      if (
        hasReachedSessionCapacity({
          streamableSessions: sessions.size,
          pendingSessions: pendingSessions.size,
          sseSessions: sseSessions.size,
          maxSessions: env.MAX_SESSIONS
        })
      ) {
        res.status(503).send(`Maximum ${env.MAX_SESSIONS} concurrent sessions reached`);
        return;
      }

      const server = createMcpServer(context);
      const transport = new SSEServerTransport("/messages", res);
      sessionId = transport.sessionId;
      const state: SseSessionState = {
        sessionId,
        server,
        transport,
        lastAccessAt: Date.now(),
        closed: false
      };
      sseSessions.set(sessionId, state);
      const currentSessionId = sessionId;

      res.on("close", () => {
        void closeSseSession(currentSessionId, "client-close");
      });

      await runWithSessionAuth(
        {
          sessionId,
          token: parsedAuth?.token ?? fallbackToken,
          apiUrl: parsedAuth?.apiUrl ?? env.GITLAB_API_URL,
          header: parsedAuth?.header,
          updatedAt: Date.now()
        },
        async () => {
          await server.connect(transport);
        }
      );
      logger.info({ sessionId }, "MCP SSE session initialized");
    } catch (error) {
      if (sessionId) {
        await closeSseSession(sessionId, "connect-error");
      }
      logger.error({ err: error, sessionId }, "Failed to initialize SSE session");
      if (!res.headersSent) {
        res.status(500).send("Failed to initialize SSE session");
      }
    }
  });

  app.post("/messages", async (req, res) => {
    let sessionId: string | undefined;
    try {
      sessionId = String(req.query.sessionId ?? "");
      if (!sessionId) {
        res.status(400).send("Missing sessionId");
        return;
      }

      const session = sseSessions.get(sessionId);
      if (!session || session.closed) {
        res.status(400).send("No transport found for sessionId");
        return;
      }

      const parsedAuth = parseRequestAuth(req);
      const fallbackToken = env.REMOTE_AUTHORIZATION ? undefined : env.GITLAB_PERSONAL_ACCESS_TOKEN;
      session.lastAccessAt = Date.now();

      await runWithSessionAuth(
        {
          sessionId,
          token: parsedAuth?.token ?? fallbackToken,
          apiUrl: parsedAuth?.apiUrl ?? env.GITLAB_API_URL,
          header: parsedAuth?.header,
          updatedAt: Date.now()
        },
        async () => {
          await session.transport.handlePostMessage(req, res);
        }
      );
    } catch (error) {
      logger.error({ err: error, sessionId }, "SSE post message failed");
      if (!res.headersSent) {
        res.status(500).send("SSE message processing failed");
      }
    }
  });
}

app.all("/mcp", async (req, res) => {
  const incomingSessionId = req.header("mcp-session-id") ?? undefined;
  const parsedAuth = parseRequestAuth(req);

  try {
    if (env.REMOTE_AUTHORIZATION && !parsedAuth?.token) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32010,
          message:
            "Missing remote authorization token. Provide 'Authorization: Bearer <token>' or 'Private-Token'."
        },
        id: null
      });
      return;
    }

    if (env.REMOTE_AUTHORIZATION && env.ENABLE_DYNAMIC_API_URL && !parsedAuth?.apiUrl) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32011,
          message:
            "Missing 'X-GitLab-API-URL' while ENABLE_DYNAMIC_API_URL=true and REMOTE_AUTHORIZATION=true."
        },
        id: null
      });
      return;
    }

    let session = incomingSessionId ? sessions.get(incomingSessionId) : undefined;

    if (incomingSessionId && !session) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: `Unknown session '${incomingSessionId}'`
        },
        id: null
      });
      return;
    }

    if (!session) {
      if (req.method !== "POST") {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Session not initialized. First call must be a POST initialize request."
          },
          id: null
        });
        return;
      }

      if (
        hasReachedSessionCapacity({
          streamableSessions: sessions.size,
          pendingSessions: pendingSessions.size,
          sseSessions: sseSessions.size,
          maxSessions: env.MAX_SESSIONS
        })
      ) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: {
            code: -32002,
            message: `Maximum ${env.MAX_SESSIONS} concurrent sessions reached`
          },
          id: null
        });
        return;
      }

      session = await createSession(parsedAuth);
    } else {
      refreshSessionAuth(session, parsedAuth);
    }

    if (!checkSessionRateLimit(session)) {
      res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32003,
          message: `Rate limit exceeded: max ${env.MAX_REQUESTS_PER_MINUTE} requests/min per session`
        },
        id: null
      });
      return;
    }

    await enqueueSessionRequest(session, async () => {
      const runtimeAuth = buildRuntimeAuth(session);
      await runWithSessionAuth(runtimeAuth, async () => {
        await session.transport.handleRequest(req, res, req.body);
      });
    });
  } catch (error) {
    logger.error(
      {
        err: error,
        method: req.method,
        sessionId: incomingSessionId
      },
      "MCP HTTP request failed"
    );

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

const httpServer = createServer(app);

httpServer.listen(env.HTTP_PORT, env.HTTP_HOST, () => {
  logger.info(
    {
      host: env.HTTP_HOST,
      port: env.HTTP_PORT,
      transport: env.SSE ? "streamable-http+sse" : "streamable-http",
      jsonOnly: env.HTTP_JSON_ONLY,
      maxSessions: env.MAX_SESSIONS,
      sessionTimeoutSeconds: env.SESSION_TIMEOUT_SECONDS,
      remoteAuthEnabled: env.REMOTE_AUTHORIZATION
    },
    "MCP HTTP server started"
  );
});

const gcInterval = setInterval(() => {
  void garbageCollectSessions();
}, 30_000);

gcInterval.unref();

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

async function createSession(initialAuth?: SessionAuth): Promise<SessionState> {
  const server = createMcpServer(context);
  const state: SessionState = {
    server,
    transport: undefined as unknown as StreamableHTTPServerTransport,
    lastAccessAt: Date.now(),
    queue: Promise.resolve(),
    activeRequests: 0,
    closed: false,
    auth: initialAuth,
    rateLimit: {
      windowStart: Date.now(),
      count: 0
    }
  };

  pendingSessions.add(state);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: env.HTTP_JSON_ONLY,
    onsessioninitialized: (sessionId) => {
      state.sessionId = sessionId;
      state.lastAccessAt = Date.now();
      sessions.set(sessionId, state);
      pendingSessions.delete(state);
      logger.info({ sessionId }, "MCP session initialized");
    },
    onsessionclosed: async (sessionId) => {
      await closeSession(sessionId, "transport-close");
    }
  });

  state.transport = transport;

  transport.onerror = (error) => {
    logger.error({ err: error, sessionId: state.sessionId }, "MCP transport error");
  };

  try {
    await server.connect(transport);
    return state;
  } catch (error) {
    pendingSessions.delete(state);

    if (state.sessionId) {
      await closeSession(state.sessionId, "transport-close");
      throw error;
    }

    state.closed = true;
    try {
      await transport.close();
    } catch (closeError) {
      logger.warn({ err: closeError }, "Failed to close transport after session init failure");
    }

    try {
      await server.close();
    } catch (closeError) {
      logger.warn({ err: closeError }, "Failed to close MCP server after session init failure");
    }

    throw error;
  }
}

function checkSessionRateLimit(session: SessionState): boolean {
  const now = Date.now();
  const oneMinute = 60_000;

  if (now - session.rateLimit.windowStart >= oneMinute) {
    session.rateLimit.windowStart = now;
    session.rateLimit.count = 0;
  }

  if (session.rateLimit.count >= env.MAX_REQUESTS_PER_MINUTE) {
    return false;
  }

  session.rateLimit.count += 1;
  return true;
}

function refreshSessionAuth(session: SessionState, auth?: SessionAuth): void {
  if (!auth) {
    return;
  }

  session.auth = auth;
  session.lastAccessAt = Date.now();
}

function buildRuntimeAuth(session: SessionState): SessionAuth | undefined {
  const fallbackToken = env.REMOTE_AUTHORIZATION ? undefined : env.GITLAB_PERSONAL_ACCESS_TOKEN;

  return {
    sessionId: session.sessionId,
    token: session.auth?.token ?? fallbackToken,
    apiUrl: session.auth?.apiUrl ?? env.GITLAB_API_URL,
    header: session.auth?.header,
    updatedAt: session.auth?.updatedAt ?? Date.now()
  };
}

function parseRequestAuth(req: express.Request): SessionAuth | undefined {
  if (!env.REMOTE_AUTHORIZATION) {
    return undefined;
  }

  const privateToken = req.header("private-token")?.trim();
  const authorization = req.header("authorization")?.trim();

  const bearerToken = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : undefined;

  const token = privateToken || bearerToken;

  let apiUrl: string | undefined;

  if (env.ENABLE_DYNAMIC_API_URL) {
    const dynamicApiUrl = req.header("x-gitlab-api-url")?.trim();
    if (dynamicApiUrl) {
      try {
        apiUrl = new URL(dynamicApiUrl).toString();
      } catch {
        throw new Error(`Invalid x-gitlab-api-url header: '${dynamicApiUrl}'`);
      }
    }
  }

  if (!token && !apiUrl) {
    return undefined;
  }

  return {
    token,
    apiUrl,
    header: privateToken ? "private-token" : bearerToken ? "authorization" : undefined,
    updatedAt: Date.now()
  };
}

async function enqueueSessionRequest(
  session: SessionState,
  task: () => Promise<void>
): Promise<void> {
  const queued = session.queue.then(async () => {
    session.activeRequests += 1;
    session.lastAccessAt = Date.now();

    try {
      await task();
    } finally {
      session.activeRequests -= 1;
      session.lastAccessAt = Date.now();
    }
  });

  session.queue = queued.catch(() => undefined);
  await queued;
}

async function garbageCollectSessions(): Promise<void> {
  const now = Date.now();
  const timeoutMs = env.SESSION_TIMEOUT_SECONDS * 1000;

  for (const [sessionId, session] of sessions) {
    if (session.activeRequests > 0 || session.closed) {
      continue;
    }

    if (now - session.lastAccessAt < timeoutMs) {
      continue;
    }

    await closeSession(sessionId, "idle-timeout");
  }

  for (const [sessionId, session] of sseSessions) {
    if (session.closed) {
      continue;
    }

    if (now - session.lastAccessAt < timeoutMs) {
      continue;
    }

    await closeSseSession(sessionId, "idle-timeout");
  }
}

async function closeSession(
  sessionId: string,
  reason: "transport-close" | "idle-timeout" | "shutdown"
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.closed) {
    return;
  }

  session.closed = true;
  sessions.delete(sessionId);

  try {
    await session.transport.close();
  } catch (error) {
    logger.warn({ err: error, sessionId, reason }, "Failed to close transport cleanly");
  }

  try {
    await session.server.close();
  } catch (error) {
    logger.warn({ err: error, sessionId, reason }, "Failed to close MCP server cleanly");
  }

  logger.info({ sessionId, reason }, "MCP session closed");
}

async function closeSseSession(
  sessionId: string,
  reason: "client-close" | "connect-error" | "idle-timeout" | "shutdown"
): Promise<void> {
  const session = sseSessions.get(sessionId);
  if (!session || session.closed) {
    return;
  }

  session.closed = true;
  sseSessions.delete(sessionId);

  try {
    await session.transport.close();
  } catch (error) {
    logger.warn({ err: error, sessionId, reason }, "Failed to close SSE transport cleanly");
  }

  try {
    await session.server.close();
  } catch (error) {
    logger.warn({ err: error, sessionId, reason }, "Failed to close SSE MCP server cleanly");
  }

  logger.info({ sessionId, reason }, "MCP SSE session closed");
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "Shutting down HTTP server");

  clearInterval(gcInterval);

  const pendingClose = [...sessions.keys()].map((sessionId) => closeSession(sessionId, "shutdown"));
  const pendingSseClose = [...sseSessions.keys()].map((sessionId) =>
    closeSseSession(sessionId, "shutdown")
  );
  await Promise.allSettled([...pendingClose, ...pendingSseClose]);

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  process.exit(0);
}
