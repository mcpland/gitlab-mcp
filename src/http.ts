import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { env } from "./config/env.js";
import { GitLabClient } from "./lib/gitlab-client.js";
import { logger } from "./lib/logger.js";
import { OutputFormatter } from "./lib/output.js";
import { ToolPolicyEngine } from "./lib/policy.js";
import { createMcpServer } from "./server/build-server.js";
import type { AppContext } from "./types/context.js";

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const context: AppContext = {
  env,
  logger,
  gitlab: new GitLabClient(env.GITLAB_API_URL, env.GITLAB_PERSONAL_ACCESS_TOKEN),
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

const sessions = new Map<string, Session>();
const app = createMcpExpressApp({ host: env.HTTP_HOST });

app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", server: env.MCP_SERVER_NAME });
});

app.all("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  let session = sessionId ? sessions.get(sessionId) : undefined;

  try {
    if (!session && req.method !== "POST") {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Missing MCP session. Start with an initialize POST request."
        },
        id: null
      });
      return;
    }

    if (!session) {
      session = await createSession();
    }

    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ err: error, sessionId, method: req.method }, "MCP HTTP request failed");

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
      transport: "streamable-http",
      jsonOnly: env.HTTP_JSON_ONLY
    },
    "MCP HTTP server started"
  );
});

const stop = (signal: NodeJS.Signals) => {
  void shutdown(signal);
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

async function createSession(): Promise<Session> {
  const server = createMcpServer(context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: env.HTTP_JSON_ONLY,
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport });
      logger.info({ sessionId: id }, "MCP session initialized");
    },
    onsessionclosed: async (id) => {
      const activeSession = sessions.get(id);
      sessions.delete(id);

      if (activeSession) {
        await activeSession.server.close();
      }

      logger.info({ sessionId: id }, "MCP session closed");
    }
  });

  transport.onerror = (error) => {
    logger.error({ err: error }, "MCP transport error");
  };

  await server.connect(transport);

  return { server, transport };
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ signal }, "Shutting down HTTP server");

  const closeResults = await Promise.allSettled(
    [...sessions.values()].map(async (session) => {
      await session.transport.close();
      await session.server.close();
    })
  );

  for (const result of closeResults) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "Failed to close a session cleanly");
    }
  }

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
