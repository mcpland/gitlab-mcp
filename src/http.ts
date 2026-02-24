#!/usr/bin/env node

import { createServer } from "node:http";

import { env } from "./config/env.js";
import { GitLabClient } from "./lib/gitlab-client.js";
import { logger } from "./lib/logger.js";
import { configureNetworkRuntime } from "./lib/network.js";
import { OutputFormatter } from "./lib/output.js";
import { ToolPolicyEngine } from "./lib/policy.js";
import { GitLabRequestRuntime } from "./lib/request-runtime.js";
import { setupMcpHttpApp } from "./http-app.js";
import type { AppContext } from "./types/context.js";

/* ------------------------------------------------------------------ */
/*  Module entry point                                                 */
/* ------------------------------------------------------------------ */

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

const { app, shutdown, garbageCollectSessions } = setupMcpHttpApp({ context, env, logger });

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
  void shutdown(httpServer, gcInterval);
});

process.once("SIGTERM", () => {
  void shutdown(httpServer, gcInterval);
});
