import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setupMcpHttpApp } from "../src/http-app.js";
import { OutputFormatter } from "../src/lib/output.js";
import { ToolPolicyEngine } from "../src/lib/policy.js";
import type { AppContext } from "../src/types/context.js";

const defaultFeatures = {
  wiki: true,
  milestone: true,
  pipeline: true,
  release: true
};

function buildContext(overrides?: { maxSessions?: number }): AppContext {
  return {
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MCP_SERVER_NAME: "http-app-test",
      MCP_SERVER_VERSION: "0.0.1",
      GITLAB_API_URL: "https://gitlab.example.com/api/v4",
      GITLAB_API_URLS: ["https://gitlab.example.com/api/v4"],
      GITLAB_PERSONAL_ACCESS_TOKEN: "test-token",
      GITLAB_USE_OAUTH: false,
      GITLAB_OAUTH_AUTO_OPEN_BROWSER: false,
      GITLAB_OAUTH_SCOPES: "api",
      GITLAB_READ_ONLY_MODE: false,
      GITLAB_ALLOWED_PROJECT_IDS: [],
      GITLAB_ALLOWED_TOOLS: [],
      GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: false,
      GITLAB_RESPONSE_MODE: "json",
      GITLAB_MAX_RESPONSE_BYTES: 200_000,
      GITLAB_HTTP_TIMEOUT_MS: 20_000,
      GITLAB_ERROR_DETAIL_MODE: "full",
      GITLAB_CLOUDFLARE_BYPASS: false,
      GITLAB_ALLOW_INSECURE_TOKEN_FILE: false,
      GITLAB_ALLOW_INSECURE_TLS: false,
      GITLAB_COOKIE_WARMUP_PATH: "/user",
      USE_GITLAB_WIKI: true,
      USE_MILESTONE: true,
      USE_PIPELINE: true,
      USE_RELEASE: true,
      REMOTE_AUTHORIZATION: false,
      ENABLE_DYNAMIC_API_URL: false,
      HTTP_JSON_ONLY: false,
      SSE: false,
      SESSION_TIMEOUT_SECONDS: 3600,
      MAX_SESSIONS: overrides?.maxSessions ?? 1000,
      MAX_REQUESTS_PER_MINUTE: 300,
      HTTP_HOST: "127.0.0.1",
      HTTP_PORT: 3333,
      GITLAB_TOKEN_CACHE_SECONDS: 300,
      GITLAB_TOKEN_SCRIPT_TIMEOUT_MS: 10_000,
      GITLAB_OAUTH_GITLAB_URL: undefined,
      GITLAB_OAUTH_CLIENT_ID: undefined,
      GITLAB_OAUTH_CLIENT_SECRET: undefined,
      GITLAB_OAUTH_REDIRECT_URI: undefined,
      GITLAB_OAUTH_TOKEN_PATH: undefined,
      GITLAB_AUTH_COOKIE_PATH: undefined,
      GITLAB_USER_AGENT: undefined,
      GITLAB_ACCEPT_LANGUAGE: undefined,
      GITLAB_TOKEN_SCRIPT: undefined,
      GITLAB_TOKEN_FILE: undefined,
      GITLAB_CA_CERT_PATH: undefined,
      GITLAB_DENIED_TOOLS_REGEX: undefined,
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined
    } as AppContext["env"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => ({}) as never
    } as unknown as AppContext["logger"],
    gitlab: {} as AppContext["gitlab"],
    policy: new ToolPolicyEngine({
      readOnlyMode: false,
      allowedTools: [],
      enabledFeatures: defaultFeatures
    }),
    formatter: new OutputFormatter({
      responseMode: "json",
      maxBytes: 200_000
    })
  };
}

interface RunningServer {
  baseUrl: string;
  pendingSessions: ReturnType<typeof setupMcpHttpApp>["pendingSessions"];
  close: () => Promise<void>;
}

async function startServer(maxSessions?: number): Promise<RunningServer> {
  const context = buildContext({ maxSessions });
  const setup = setupMcpHttpApp({
    context,
    env: context.env,
    logger: context.logger
  });

  const httpServer = createServer(setup.app);

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected HTTP server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    pendingSessions: setup.pendingSessions,
    close: async () => {
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
  };
}

let running: RunningServer | undefined;

afterEach(async () => {
  if (!running) {
    return;
  }

  await running.close();
  running = undefined;
});

describe("http app pending session handling", () => {
  it("releases pending session for invalid initial POST requests", async () => {
    running = await startServer();

    const response = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "foo"
      })
    });

    expect(response.status).toBe(406);
    expect(running.pendingSessions.size).toBe(0);
  });

  it("does not exhaust max sessions with repeated invalid initial POST requests", async () => {
    running = await startServer(1);

    const first = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "foo"
      })
    });

    const second = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "foo"
      })
    });

    expect(first.status).toBe(406);
    expect(second.status).toBe(406);
    expect(running.pendingSessions.size).toBe(0);
  });

  it("reports degraded health when pending sessions reach capacity", async () => {
    running = await startServer(1);

    running.pendingSessions.add({
      closed: false
    } as never);

    const response = await fetch(`${running.baseUrl}/healthz`);
    const body = (await response.json()) as { status: string };

    expect(body.status).toBe("degraded");
  });
});
