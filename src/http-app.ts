import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  OAuthMetadata,
  OAuthProtectedResourceMetadata
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Express } from "express";
import express from "express";

import { runWithSessionAuth, type SessionAuth } from "./lib/auth-context.js";
import {
  decryptDownloadToken,
  downloadTokenResourceMatches,
  type DownloadTokenResource
} from "./lib/download-token.js";
import { encodeGitLabProjectId } from "./lib/gitlab-path.js";
import { hasReachedSessionCapacity } from "./lib/session-capacity.js";
import { createGitLabMcpOAuthProvider } from "./lib/mcp-oauth-provider.js";
import { verifyMcpHttpBearerToken } from "./lib/mcp-http-bearer-auth.js";
import { resolveOauthScopes } from "./lib/oauth-scopes.js";
import { createMcpServer } from "./server/build-server.js";
import type { GitLabAuthHeader } from "./types/auth.js";
import type { AppContext } from "./types/context.js";

/* ------------------------------------------------------------------ */
/*  Session types                                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Exported factory — testable                                        */
/* ------------------------------------------------------------------ */

export interface SetupMcpHttpAppDeps {
  context: AppContext;
  env: AppContext["env"];
  logger: AppContext["logger"];
}

export interface SetupMcpHttpAppResult {
  app: Express;
  sessions: Map<string, SessionState>;
  pendingSessions: Set<SessionState>;
  sseSessions: Map<string, SseSessionState>;
  closeSession: (
    sessionId: string,
    reason: "transport-close" | "idle-timeout" | "shutdown"
  ) => Promise<void>;
  closeSseSession: (
    sessionId: string,
    reason: "client-close" | "connect-error" | "idle-timeout" | "shutdown"
  ) => Promise<void>;
  garbageCollectSessions: () => Promise<void>;
  shutdown: (httpServer: HttpServer, gcInterval: ReturnType<typeof setInterval>) => Promise<void>;
}

interface InstallMcpOAuthRoutesOptions {
  provider: OAuthServerProvider;
  issuerUrl: URL;
  scopesSupported: string[];
  resourceName: string;
  resourceServerUrl: URL;
}

function installMcpOAuthRoutes(app: Express, options: InstallMcpOAuthRoutesOptions): void {
  const pathPrefix = getUrlPathPrefix(options.issuerUrl);
  const routerOptions = {
    provider: options.provider,
    issuerUrl: options.issuerUrl,
    baseUrl: options.issuerUrl,
    scopesSupported: options.scopesSupported,
    resourceName: options.resourceName,
    resourceServerUrl: options.resourceServerUrl
  };

  if (pathPrefix) {
    const oauthMetadata = createPathAwareOAuthMetadata(options);
    const protectedResourceMetadata = createPathAwareProtectedResourceMetadata(
      options,
      oauthMetadata
    );

    for (const route of getPrefixedOAuthMetadataRoutes(
      "/.well-known/oauth-authorization-server",
      pathPrefix
    )) {
      app.use(route, metadataHandler(oauthMetadata));
    }

    for (const route of getPrefixedOAuthMetadataRoutes(
      "/.well-known/oauth-protected-resource",
      pathPrefix
    )) {
      app.use(route, metadataHandler(protectedResourceMetadata));
    }
  }

  app.use(mcpAuthRouter(routerOptions));

  if (pathPrefix) {
    app.use(pathPrefix, mcpAuthRouter(routerOptions));
  }
}

function createPathAwareOAuthMetadata(options: InstallMcpOAuthRoutesOptions): OAuthMetadata {
  const metadata = createOAuthMetadata({
    provider: options.provider,
    issuerUrl: options.issuerUrl,
    baseUrl: options.issuerUrl,
    scopesSupported: options.scopesSupported
  });

  return {
    ...metadata,
    authorization_endpoint: buildUrlWithPathPrefix(options.issuerUrl, "authorize"),
    token_endpoint: buildUrlWithPathPrefix(options.issuerUrl, "token"),
    registration_endpoint: metadata.registration_endpoint
      ? buildUrlWithPathPrefix(options.issuerUrl, "register")
      : undefined,
    revocation_endpoint: metadata.revocation_endpoint
      ? buildUrlWithPathPrefix(options.issuerUrl, "revoke")
      : undefined
  };
}

function createPathAwareProtectedResourceMetadata(
  options: InstallMcpOAuthRoutesOptions,
  oauthMetadata: OAuthMetadata
): OAuthProtectedResourceMetadata {
  return {
    resource: options.resourceServerUrl.href,
    authorization_servers: [oauthMetadata.issuer],
    scopes_supported: options.scopesSupported,
    resource_name: options.resourceName
  };
}

function buildUrlWithPathPrefix(baseUrl: URL, routeName: string): string {
  const url = new URL(baseUrl.href);
  const pathPrefix = getUrlPathPrefix(baseUrl);
  url.pathname = `${pathPrefix}/${routeName}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function getUrlPathPrefix(url: URL): string {
  return url.pathname.replace(/\/+$/, "");
}

function getConfiguredServerPathPrefix(env: AppContext["env"]): string {
  return env.MCP_SERVER_URL ? getUrlPathPrefix(new URL(env.MCP_SERVER_URL)) : "";
}

function isMcpRequestPath(path: string, pathPrefix: string): boolean {
  return path === "/mcp" || (pathPrefix.length > 0 && path === `${pathPrefix}/mcp`);
}

function isMcpTransportPath(path: string, pathPrefix: string): boolean {
  const transportPaths = ["/mcp", "/sse", "/messages"];
  return transportPaths.some(
    (transportPath) =>
      path === transportPath || (pathPrefix.length > 0 && path === `${pathPrefix}${transportPath}`)
  );
}

function getPrefixedOAuthMetadataRoutes(metadataRoute: string, pathPrefix: string): string[] {
  return Array.from(
    new Set([metadataRoute, `${metadataRoute}${pathPrefix}`, `${pathPrefix}${metadataRoute}`])
  );
}

export function setupMcpHttpApp(deps: SetupMcpHttpAppDeps): SetupMcpHttpAppResult {
  const { context, env: appEnv, logger: appLogger } = deps;
  const configuredPathPrefix = getConfiguredServerPathPrefix(appEnv);

  const app = createMcpExpressApp({ host: appEnv.HTTP_HOST });
  app.use((req, res, next) => {
    const expectedToken = appEnv.MCP_HTTP_AUTH_TOKEN;
    if (!expectedToken || !isMcpTransportPath(req.path, configuredPathPrefix)) {
      next();
      return;
    }

    if (verifyMcpHttpBearerToken(req.header("authorization"), expectedToken)) {
      next();
      return;
    }

    res.setHeader("WWW-Authenticate", 'Bearer realm="gitlab-mcp"');
    if (isMcpRequestPath(req.path, configuredPathPrefix)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32014,
          message: "Missing or invalid MCP HTTP bearer token"
        },
        id: null
      });
      return;
    }

    res.status(401).send("Missing or invalid MCP HTTP bearer token");
  });
  app.use(express.json({ limit: "2mb" }));
  app.use(
    (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!isMcpRequestPath(req.path, configuredPathPrefix) || !isJsonBodyParserError(error)) {
        next(error);
        return;
      }

      if (error.type === "entity.too.large") {
        res.status(413).json({
          jsonrpc: "2.0",
          error: {
            code: -32013,
            message: "JSON payload exceeds 2mb limit"
          },
          id: null
        });
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Invalid JSON payload"
        },
        id: null
      });
    }
  );

  const sessions = new Map<string, SessionState>();
  const pendingSessions = new Set<SessionState>();
  const sseSessions = new Map<string, SseSessionState>();
  const oauthIssuerUrl = appEnv.GITLAB_MCP_OAUTH
    ? new URL(appEnv.MCP_SERVER_URL ?? `http://${appEnv.HTTP_HOST}:${String(appEnv.HTTP_PORT)}`)
    : undefined;
  const oauthProvider = appEnv.GITLAB_MCP_OAUTH
    ? createGitLabMcpOAuthProvider(appEnv.GITLAB_API_URL)
    : undefined;
  const oauthScopes = resolveOauthScopes(appEnv.GITLAB_OAUTH_SCOPES, appEnv.GITLAB_READ_ONLY_MODE);
  const oauthBearerAuth =
    appEnv.GITLAB_MCP_OAUTH && oauthProvider && oauthIssuerUrl
      ? requireBearerAuth({
          verifier: oauthProvider,
          requiredScopes: [],
          resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauthIssuerUrl)
        })
      : undefined;

  if (appEnv.GITLAB_MCP_OAUTH && oauthProvider && oauthIssuerUrl) {
    installMcpOAuthRoutes(app, {
      provider: oauthProvider,
      issuerUrl: oauthIssuerUrl,
      scopesSupported: oauthScopes,
      resourceName: appEnv.MCP_SERVER_NAME,
      resourceServerUrl: oauthIssuerUrl
    });
  }

  /* ---- /healthz ---- */

  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: hasReachedSessionCapacity({
        streamableSessions: sessions.size,
        pendingSessions: pendingSessions.size,
        sseSessions: sseSessions.size,
        maxSessions: appEnv.MAX_SESSIONS
      })
        ? "degraded"
        : "ok",
      server: appEnv.MCP_SERVER_NAME,
      activeSessions: sessions.size,
      activeSseSessions: sseSessions.size,
      pendingSessions: pendingSessions.size,
      maxSessions: appEnv.MAX_SESSIONS,
      remoteAuthorization: appEnv.REMOTE_AUTHORIZATION,
      mcpOAuth: appEnv.GITLAB_MCP_OAUTH,
      statelessMode: appEnv.OAUTH_STATELESS_MODE,
      readOnlyMode: appEnv.GITLAB_READ_ONLY_MODE,
      sseEnabled: appEnv.SSE
    });
  });

  /* ---- Download proxy endpoints ---- */

  const downloadRateLimits = new Map<string, { count: number; resetAt: number }>();

  const downloadProxyHandler: express.RequestHandler = async (req, res) => {
    try {
      const resource = getDownloadResourceFromRequest(req);
      const auth = parseDownloadAuth(req, resource);
      if (!auth) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      if (!checkDownloadRateLimit(`${auth.header}:${auth.token}`)) {
        res.status(429).json({ error: "Rate limit exceeded" });
        return;
      }

      const gitLabPath = buildDownloadGitLabPath(resource, appEnv);
      const apiUrl = auth.apiUrl ?? getDownloadApiUrl(req);
      const url = new URL(gitLabPath.replace(/^\//, ""), `${apiUrl.replace(/\/+$/, "")}/`);
      const gitLabResponse = await fetch(url, {
        method: "GET",
        headers: toGitLabDownloadHeaders(auth),
        signal: AbortSignal.timeout(appEnv.GITLAB_HTTP_TIMEOUT_MS)
      });

      if (!gitLabResponse.ok) {
        res.status(gitLabResponse.status).json({
          error: `GitLab API error: ${gitLabResponse.status} ${gitLabResponse.statusText}`
        });
        return;
      }

      copyDownloadResponseHeaders(gitLabResponse, res);

      if (!gitLabResponse.body) {
        res.status(502).json({ error: "No response body from GitLab" });
        return;
      }

      await pipeline(
        Readable.fromWeb(gitLabResponse.body as unknown as NodeReadableStream<Uint8Array>),
        res
      );
    } catch (error) {
      appLogger.error({ err: error }, "Download proxy request failed");
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : "Failed to proxy download";
        const status = isDownloadClientError(error) ? 400 : 502;
        res.status(status).json({ error: message });
      }
    }
  };
  app.get("/downloads/:type", downloadProxyHandler);
  if (configuredPathPrefix) {
    app.get(`${configuredPathPrefix}/downloads/:type`, downloadProxyHandler);
  }

  /* ---- SSE endpoints ---- */

  if (appEnv.SSE) {
    const createSseConnectHandler =
      (messageEndpoint: string): express.RequestHandler =>
      async (req, res) => {
        let sessionId: string | undefined;
        try {
          const parsedAuth = parseRequestAuth(req);
          const fallbackToken = appEnv.REMOTE_AUTHORIZATION
            ? undefined
            : appEnv.GITLAB_PERSONAL_ACCESS_TOKEN;

          if (
            hasReachedSessionCapacity({
              streamableSessions: sessions.size,
              pendingSessions: pendingSessions.size,
              sseSessions: sseSessions.size,
              maxSessions: appEnv.MAX_SESSIONS
            })
          ) {
            res.status(503).send(`Maximum ${appEnv.MAX_SESSIONS} concurrent sessions reached`);
            return;
          }

          const server = createMcpServer(context);
          const transport = new SSEServerTransport(messageEndpoint, res);
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
              apiUrl: parsedAuth?.apiUrl ?? appEnv.GITLAB_API_URL,
              header: parsedAuth?.header,
              updatedAt: Date.now()
            },
            async () => {
              await server.connect(transport);
            }
          );
          appLogger.info({ sessionId }, "MCP SSE session initialized");
        } catch (error) {
          if (sessionId) {
            await closeSseSession(sessionId, "connect-error");
          }
          appLogger.error({ err: error, sessionId }, "Failed to initialize SSE session");
          if (!res.headersSent) {
            res.status(500).send("Failed to initialize SSE session");
          }
        }
      };

    const ssePostMessageHandler: express.RequestHandler = async (req, res) => {
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
        const fallbackToken = appEnv.REMOTE_AUTHORIZATION
          ? undefined
          : appEnv.GITLAB_PERSONAL_ACCESS_TOKEN;
        session.lastAccessAt = Date.now();

        await runWithSessionAuth(
          {
            sessionId,
            token: parsedAuth?.token ?? fallbackToken,
            apiUrl: parsedAuth?.apiUrl ?? appEnv.GITLAB_API_URL,
            header: parsedAuth?.header,
            updatedAt: Date.now()
          },
          async () => {
            await session.transport.handlePostMessage(req, res, req.body);
          }
        );
      } catch (error) {
        appLogger.error({ err: error, sessionId }, "SSE post message failed");
        if (!res.headersSent) {
          res.status(500).send("SSE message processing failed");
        }
      }
    };

    app.get("/sse", createSseConnectHandler("/messages"));
    app.post("/messages", ssePostMessageHandler);
    if (configuredPathPrefix) {
      app.get(
        `${configuredPathPrefix}/sse`,
        createSseConnectHandler(`${configuredPathPrefix}/messages`)
      );
      app.post(`${configuredPathPrefix}/messages`, ssePostMessageHandler);
    }
  }

  /* ---- /mcp (streamable HTTP) ---- */

  const mcpOAuthAuthMiddleware: express.RequestHandler = (req, res, next) => {
    if (!oauthBearerAuth) {
      next();
      return;
    }

    if (req.header("private-token")?.trim() || req.header("job-token")?.trim()) {
      next();
      return;
    }

    oauthBearerAuth(req, res, next);
  };

  const mcpRequestHandler: express.RequestHandler = async (req, res) => {
    const incomingSessionId = req.header("mcp-session-id") ?? undefined;
    let session = incomingSessionId ? sessions.get(incomingSessionId) : undefined;
    let createdSession = false;

    try {
      const parsedAuth = parseRequestAuth(req);

      if ((appEnv.REMOTE_AUTHORIZATION || appEnv.GITLAB_MCP_OAUTH) && !parsedAuth?.token) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32010,
            message: appEnv.REMOTE_AUTHORIZATION
              ? "Missing remote authorization token. Provide 'Authorization: Bearer <token>', 'Private-Token', or 'Job-Token'."
              : "Missing OAuth authorization token. Provide 'Authorization: Bearer <token>', 'Private-Token', or 'Job-Token'."
          },
          id: null
        });
        return;
      }

      if (appEnv.REMOTE_AUTHORIZATION && appEnv.ENABLE_DYNAMIC_API_URL && !parsedAuth?.apiUrl) {
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

      if (appEnv.OAUTH_STATELESS_MODE) {
        await handleStatelessMcpRequest(req, res, parsedAuth);
        return;
      }

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
            maxSessions: appEnv.MAX_SESSIONS
          })
        ) {
          res.status(503).json({
            jsonrpc: "2.0",
            error: {
              code: -32002,
              message: `Maximum ${appEnv.MAX_SESSIONS} concurrent sessions reached`
            },
            id: null
          });
          return;
        }

        session = await createSession(parsedAuth);
        createdSession = true;
      } else {
        refreshSessionAuth(session, parsedAuth);
      }

      if (!session) {
        throw new Error("Session state missing after initialization");
      }
      const activeSession = session;

      if (!checkSessionRateLimit(activeSession)) {
        res.status(429).json({
          jsonrpc: "2.0",
          error: {
            code: -32003,
            message: `Rate limit exceeded: max ${appEnv.MAX_REQUESTS_PER_MINUTE} requests/min per session`
          },
          id: null
        });
        return;
      }

      await enqueueSessionRequest(activeSession, async () => {
        const runtimeAuth = buildRuntimeAuth(activeSession);
        await runWithSessionAuth(runtimeAuth, async () => {
          await activeSession.transport.handleRequest(req, res, req.body);
        });
      });
    } catch (error) {
      appLogger.error(
        {
          err: error,
          method: req.method,
          sessionId: incomingSessionId
        },
        "MCP HTTP request failed"
      );

      if (!res.headersSent && isClientHeaderValidationError(error)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32012,
            message: error.message
          },
          id: null
        });
        return;
      }

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
    } finally {
      if (createdSession && session) {
        await discardPendingSessionIfUninitialized(session);
      }
    }
  };

  app.all("/mcp", mcpOAuthAuthMiddleware, mcpRequestHandler);
  if (configuredPathPrefix) {
    app.all(`${configuredPathPrefix}/mcp`, mcpOAuthAuthMiddleware, mcpRequestHandler);
  }

  /* ---- Internal helpers (closures) ---- */

  async function handleStatelessMcpRequest(
    req: express.Request,
    res: express.Response,
    auth?: SessionAuth
  ): Promise<void> {
    const server = createMcpServer(context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: appEnv.HTTP_JSON_ONLY
    });

    transport.onerror = (error) => {
      appLogger.error({ err: error }, "MCP stateless transport error");
    };

    const fallbackToken =
      appEnv.REMOTE_AUTHORIZATION || appEnv.GITLAB_MCP_OAUTH
        ? undefined
        : appEnv.GITLAB_PERSONAL_ACCESS_TOKEN;

    try {
      await server.connect(transport);
      await runWithSessionAuth(
        {
          sessionId: undefined,
          token: auth?.token ?? fallbackToken,
          apiUrl: auth?.apiUrl ?? appEnv.GITLAB_API_URL,
          header: auth?.header,
          updatedAt: auth?.updatedAt ?? Date.now()
        },
        async () => {
          await transport.handleRequest(req, res, req.body);
        }
      );
    } finally {
      try {
        await transport.close();
      } catch (error) {
        appLogger.warn({ err: error }, "Failed to close stateless transport cleanly");
      }

      try {
        await server.close();
      } catch (error) {
        appLogger.warn({ err: error }, "Failed to close stateless MCP server cleanly");
      }
    }
  }

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
      enableJsonResponse: appEnv.HTTP_JSON_ONLY,
      onsessioninitialized: (sessionId) => {
        state.sessionId = sessionId;
        state.lastAccessAt = Date.now();
        sessions.set(sessionId, state);
        pendingSessions.delete(state);
        appLogger.info({ sessionId }, "MCP session initialized");
      },
      onsessionclosed: async (sessionId) => {
        await closeSession(sessionId, "transport-close");
      }
    });

    state.transport = transport;

    transport.onerror = (error) => {
      appLogger.error({ err: error, sessionId: state.sessionId }, "MCP transport error");
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
        appLogger.warn({ err: closeError }, "Failed to close transport after session init failure");
      }

      try {
        await server.close();
      } catch (closeError) {
        appLogger.warn(
          { err: closeError },
          "Failed to close MCP server after session init failure"
        );
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

    if (session.rateLimit.count >= appEnv.MAX_REQUESTS_PER_MINUTE) {
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
    const fallbackToken =
      appEnv.REMOTE_AUTHORIZATION || appEnv.GITLAB_MCP_OAUTH
        ? undefined
        : appEnv.GITLAB_PERSONAL_ACCESS_TOKEN;

    return {
      sessionId: session.sessionId,
      token: session.auth?.token ?? fallbackToken,
      apiUrl: session.auth?.apiUrl ?? appEnv.GITLAB_API_URL,
      header: session.auth?.header,
      updatedAt: session.auth?.updatedAt ?? Date.now()
    };
  }

  function checkDownloadRateLimit(key: string): boolean {
    const now = Date.now();
    const entry = downloadRateLimits.get(key);
    if (!entry || now >= entry.resetAt) {
      downloadRateLimits.set(key, { count: 1, resetAt: now + 60_000 });
      evictExpiredDownloadRateLimits(now);
      return true;
    }

    if (entry.count >= appEnv.MAX_REQUESTS_PER_MINUTE) {
      return false;
    }

    entry.count += 1;
    return true;
  }

  function evictExpiredDownloadRateLimits(now: number): void {
    for (const [key, entry] of downloadRateLimits) {
      if (now >= entry.resetAt) {
        downloadRateLimits.delete(key);
      }
    }
  }

  function parseDownloadAuth(
    req: express.Request,
    resource: DownloadTokenResource
  ): (SessionAuth & { token: string; header: GitLabAuthHeader }) | undefined {
    const encryptedToken = getSingleQueryValue(req.query._token);
    if (encryptedToken) {
      const payload = decryptDownloadToken(encryptedToken, {
        secret: appEnv.GITLAB_DOWNLOAD_TOKEN_SECRET
      });
      if (!payload || !downloadTokenResourceMatches(payload, resource)) {
        throw new DownloadClientError("Invalid or expired download token");
      }

      return {
        token: payload.token,
        header: payload.header,
        apiUrl: payload.apiUrl,
        updatedAt: Date.now()
      };
    }

    const parsedAuth = parseRequestAuth(req);
    if (parsedAuth?.token && parsedAuth.header) {
      return {
        token: parsedAuth.token,
        header: parsedAuth.header,
        apiUrl: parsedAuth.apiUrl,
        updatedAt: parsedAuth.updatedAt
      };
    }

    if (!appEnv.REMOTE_AUTHORIZATION) {
      if (appEnv.GITLAB_PERSONAL_ACCESS_TOKEN) {
        return {
          token: appEnv.GITLAB_PERSONAL_ACCESS_TOKEN,
          header: "private-token",
          updatedAt: Date.now()
        };
      }

      if (appEnv.GITLAB_JOB_TOKEN) {
        return {
          token: appEnv.GITLAB_JOB_TOKEN,
          header: "job-token",
          updatedAt: Date.now()
        };
      }
    }

    return undefined;
  }

  function getDownloadApiUrl(req: express.Request): string {
    if (!appEnv.ENABLE_DYNAMIC_API_URL) {
      return appEnv.GITLAB_API_URL;
    }

    const dynamicApiUrl = req.header("x-gitlab-api-url")?.trim();
    if (!dynamicApiUrl) {
      return appEnv.GITLAB_API_URL;
    }

    try {
      const parsedApiUrl = new URL(dynamicApiUrl);
      if (!isHttpUrl(parsedApiUrl)) {
        throw new Error("unsupported protocol");
      }
      return parsedApiUrl.toString();
    } catch {
      throw new DownloadClientError(`Invalid x-gitlab-api-url header: '${dynamicApiUrl}'`);
    }
  }

  function parseRequestAuth(req: express.Request): SessionAuth | undefined {
    if (!appEnv.REMOTE_AUTHORIZATION && !appEnv.GITLAB_MCP_OAUTH) {
      return undefined;
    }

    const privateToken = req.header("private-token")?.trim();
    const jobToken = req.header("job-token")?.trim();
    const authorization = req.header("authorization")?.trim();

    const bearerToken = authorization?.toLowerCase().startsWith("bearer ")
      ? authorization.slice(7).trim()
      : undefined;

    const token = privateToken || jobToken || bearerToken;

    let apiUrl: string | undefined;

    if (appEnv.ENABLE_DYNAMIC_API_URL) {
      const dynamicApiUrl = req.header("x-gitlab-api-url")?.trim();
      if (dynamicApiUrl) {
        try {
          const parsedApiUrl = new URL(dynamicApiUrl);
          if (!isHttpUrl(parsedApiUrl)) {
            throw new Error("unsupported protocol");
          }
          apiUrl = parsedApiUrl.toString();
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
      header: privateToken
        ? "private-token"
        : jobToken
          ? "job-token"
          : bearerToken
            ? "authorization"
            : undefined,
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
    const timeoutMs = appEnv.SESSION_TIMEOUT_SECONDS * 1000;

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

  async function discardPendingSessionIfUninitialized(session: SessionState): Promise<void> {
    if (session.closed || session.sessionId || !pendingSessions.has(session)) {
      return;
    }

    session.closed = true;
    pendingSessions.delete(session);

    try {
      await session.transport.close();
    } catch (error) {
      appLogger.warn({ err: error }, "Failed to close uninitialized transport cleanly");
    }

    try {
      await session.server.close();
    } catch (error) {
      appLogger.warn({ err: error }, "Failed to close uninitialized MCP server cleanly");
    }

    appLogger.info("Discarded uninitialized pending session");
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
      appLogger.warn({ err: error, sessionId, reason }, "Failed to close transport cleanly");
    }

    try {
      await session.server.close();
    } catch (error) {
      appLogger.warn({ err: error, sessionId, reason }, "Failed to close MCP server cleanly");
    }

    appLogger.info({ sessionId, reason }, "MCP session closed");
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
      appLogger.warn({ err: error, sessionId, reason }, "Failed to close SSE transport cleanly");
    }

    try {
      await session.server.close();
    } catch (error) {
      appLogger.warn({ err: error, sessionId, reason }, "Failed to close SSE MCP server cleanly");
    }

    appLogger.info({ sessionId, reason }, "MCP SSE session closed");
  }

  async function shutdown(
    httpServer: HttpServer,
    gcIntervalHandle: ReturnType<typeof setInterval>
  ): Promise<void> {
    appLogger.info("Shutting down HTTP server");

    clearInterval(gcIntervalHandle);

    const pendingClose = [...sessions.keys()].map((sessionId) =>
      closeSession(sessionId, "shutdown")
    );
    const pendingSseClose = [...sseSessions.keys()].map((sessionId) =>
      closeSseSession(sessionId, "shutdown")
    );
    const pendingInitClose = [...pendingSessions].map((session) =>
      discardPendingSessionIfUninitialized(session)
    );
    await Promise.allSettled([...pendingClose, ...pendingSseClose, ...pendingInitClose]);

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  return {
    app,
    sessions,
    pendingSessions,
    sseSessions,
    closeSession,
    closeSseSession,
    garbageCollectSessions,
    shutdown
  };
}

function getDownloadResourceFromRequest(req: express.Request): DownloadTokenResource {
  const type = Array.isArray(req.params.type) ? req.params.type[0] : req.params.type;
  if (!type) {
    throw new DownloadClientError("Missing download type");
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "_token") {
      continue;
    }
    const stringValue = getSingleQueryValue(value);
    if (stringValue !== undefined) {
      params[key] = stringValue;
    }
  }

  return { type, params };
}

function buildDownloadGitLabPath(resource: DownloadTokenResource, env: AppContext["env"]): string {
  const projectId = resource.params.project_id;
  if (!projectId) {
    throw new DownloadClientError("project_id is required");
  }
  assertDownloadProjectAllowed(projectId, env);

  switch (resource.type) {
    case "job-artifacts": {
      const jobId = resource.params.job_id;
      if (!jobId) {
        throw new DownloadClientError("job_id is required");
      }
      return `/projects/${encodeGitLabProjectId(projectId)}/jobs/${encodeURIComponent(jobId)}/artifacts`;
    }

    case "release-asset": {
      const tagName = resource.params.tag_name;
      const directAssetPath = resource.params.direct_asset_path;
      if (!tagName || !directAssetPath) {
        throw new DownloadClientError("tag_name and direct_asset_path are required");
      }
      return `/projects/${encodeGitLabProjectId(projectId)}/releases/${encodeURIComponent(
        tagName
      )}/downloads/${encodeSlashPath(directAssetPath)}`;
    }

    case "attachment": {
      const secret = resource.params.secret;
      const filename = resource.params.filename;
      if (!secret || !filename) {
        throw new DownloadClientError("secret and filename are required");
      }
      return `/projects/${encodeGitLabProjectId(projectId)}/uploads/${encodeURIComponent(
        secret
      )}/${encodeURIComponent(filename)}`;
    }

    default:
      throw new DownloadClientError(`Unknown download type: ${resource.type}`);
  }
}

function assertDownloadProjectAllowed(projectId: string, env: AppContext["env"]): void {
  if (env.GITLAB_ALLOWED_PROJECT_IDS.length === 0) {
    return;
  }

  if (!env.GITLAB_ALLOWED_PROJECT_IDS.includes(projectId)) {
    throw new DownloadClientError(`Project '${projectId}' is not allowed`);
  }
}

function toGitLabDownloadHeaders(auth: { token: string; header: GitLabAuthHeader }): HeadersInit {
  const headers = new Headers({ Accept: "application/octet-stream" });
  if (auth.header === "authorization") {
    headers.set("Authorization", `Bearer ${auth.token}`);
  } else if (auth.header === "job-token") {
    headers.set("JOB-TOKEN", auth.token);
  } else {
    headers.set("PRIVATE-TOKEN", auth.token);
  }

  return headers;
}

function copyDownloadResponseHeaders(source: Response, target: express.Response): void {
  for (const header of ["content-type", "content-disposition", "content-length"]) {
    const value = source.headers.get(header);
    if (value) {
      target.setHeader(header, value);
    }
  }
}

function getSingleQueryValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
    return value[0];
  }

  return undefined;
}

function encodeSlashPath(value: string): string {
  return value
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

class DownloadClientError extends Error {}

function isDownloadClientError(error: unknown): error is DownloadClientError {
  return error instanceof DownloadClientError;
}

function isClientHeaderValidationError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("Invalid x-gitlab-api-url header:");
}

interface JsonBodyParseError extends Error {
  type?: string;
}

function isJsonBodyParserError(error: unknown): error is JsonBodyParseError {
  return (
    error instanceof Error &&
    "type" in error &&
    ((error as { type?: string }).type === "entity.parse.failed" ||
      (error as { type?: string }).type === "entity.too.large")
  );
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}
