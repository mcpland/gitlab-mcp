import { createServer, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setupMcpHttpApp } from "../src/http-app.js";
import { createDownloadToken } from "../src/lib/download-token.js";
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
      MCP_SERVER_URL: undefined,
      MCP_HTTP_AUTH_TOKEN: undefined,
      MCP_ALLOWED_HOSTS: [],
      MCP_ALLOWED_ORIGINS: [],
      GITLAB_API_URL: "https://gitlab.example.com/api/v4",
      GITLAB_API_URLS: ["https://gitlab.example.com/api/v4"],
      GITLAB_ALLOWED_HOSTS: [],
      GITLAB_POOL_MAX_SIZE: 100,
      GITLAB_PERSONAL_ACCESS_TOKEN: "test-token",
      GITLAB_USE_OAUTH: false,
      GITLAB_MCP_OAUTH: false,
      GITLAB_OAUTH_AUTO_OPEN_BROWSER: false,
      GITLAB_OAUTH_SCOPES: "api",
      GITLAB_READ_ONLY_MODE: false,
      GITLAB_ALLOWED_PROJECT_IDS: [],
      GITLAB_ALLOWED_TOOLS: [],
      GITLAB_TOOLSETS: [],
      GITLAB_ENABLE_COMPATIBILITY_ALIASES: false,
      GITLAB_DISABLED_CAPABILITIES: [],
      GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: false,
      GITLAB_RESPONSE_MODE: "json",
      GITLAB_MAX_RESPONSE_BYTES: 200_000,
      GITLAB_MAX_LOCAL_FILE_BYTES: 250_000_000,
      GITLAB_DOWNLOAD_TOKEN_SECRET: "test-download-secret",
      GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS: 300,
      GITLAB_HTTP_TIMEOUT_MS: 20_000,
      GITLAB_AUTH_VALIDATION_TIMEOUT_MS: 5_000,
      GITLAB_AUTH_VALIDATION_TTL_SECONDS: 30,
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
      OAUTH_STATELESS_MODE: false,
      MAX_SESSIONS: overrides?.maxSessions ?? 1000,
      MAX_REQUESTS_PER_MINUTE: 300,
      MAX_REQUESTS_PER_MINUTE_PER_IP: 300,
      MCP_TRUST_PROXY: false,
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
      HTTPS_PROXY: undefined,
      NO_PROXY: undefined
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
      disabledCapabilities: [],
      allowedTools: [],
      enabledFeatures: defaultFeatures
    }),
    formatter: new OutputFormatter({
      responseMode: "json",
      maxBytes: 200_000
    }),
    allowLocalFileTools: false
  };
}

interface RunningServer {
  baseUrl: string;
  pendingSessions: ReturnType<typeof setupMcpHttpApp>["pendingSessions"];
  close: () => Promise<void>;
}

async function startServer(maxSessions?: number): Promise<RunningServer> {
  const context = buildContext({ maxSessions });
  return startServerForContext(context);
}

async function startServerForContext(context: AppContext): Promise<RunningServer> {
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
  it("returns JSON-RPC parse error for malformed JSON payload", async () => {
    running = await startServer();

    const response = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"'
    });

    const body = (await response.json()) as {
      jsonrpc: string;
      error?: { code?: number; message?: string };
      id: null;
    };

    expect(response.status).toBe(400);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32700);
    expect(body.error?.message).toContain("Invalid JSON payload");
    expect(running.pendingSessions.size).toBe(0);
  });

  it("returns JSON-RPC error for oversized JSON payload", async () => {
    running = await startServer();

    const largeBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        blob: "x".repeat(2 * 1024 * 1024 + 128)
      }
    });

    const response = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: largeBody
    });

    const body = (await response.json()) as {
      jsonrpc: string;
      error?: { code?: number; message?: string };
      id: null;
    };

    expect(response.status).toBe(413);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32013);
    expect(body.error?.message).toContain("2mb");
    expect(running.pendingSessions.size).toBe(0);
  });

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

  it("shutdown closes uninitialized pending sessions", async () => {
    const context = buildContext();
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

    const transportClose = vi.fn(async () => undefined);
    const serverClose = vi.fn(async () => undefined);

    setup.pendingSessions.add({
      closed: false,
      transport: {
        close: transportClose
      },
      server: {
        close: serverClose
      }
    } as never);

    const gcInterval = setInterval(() => undefined, 1_000);
    await setup.shutdown(httpServer, gcInterval);

    expect(transportClose).toHaveBeenCalledTimes(1);
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(setup.pendingSessions.size).toBe(0);
  });
});

describe("http app download proxy", () => {
  it("uses the shared canonical dynamic API URL policy", async () => {
    const gitLabServer = createServer((req, res) => {
      expect(req.url).toBe("/api/v4/projects/group%2Fproject/jobs/41/artifacts");
      expect(req.headers["private-token"]).toBe("dynamic-token");
      res.statusCode = 200;
      res.end("canonical-download");
    });

    await new Promise<void>((resolve, reject) => {
      gitLabServer.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }

      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
      context.env.REMOTE_AUTHORIZATION = true;
      context.env.ENABLE_DYNAMIC_API_URL = true;
      running = await startServerForContext(context);

      const url = new URL(`${running.baseUrl}/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "41");

      const response = await fetch(url, {
        headers: {
          "Private-Token": "dynamic-token",
          "X-GitLab-API-URL": `http://127.0.0.1:${gitLabAddress.port}/untrusted/path`
        }
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("canonical-download");

      const rejected = await fetch(url, {
        headers: {
          "Private-Token": "dynamic-token",
          "X-GitLab-API-URL": "https://attacker.example.com/api/v4"
        }
      });
      expect(rejected.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("streams a token-bound job artifact download", async () => {
    const gitLabServer = createServer((req, res) => {
      expect(req.url).toBe("/api/v4/projects/group%2Fproject/jobs/42/artifacts");
      expect(req.headers["private-token"]).toBe("proxy-token");
      res.statusCode = 200;
      res.setHeader("content-type", "application/zip");
      res.end("zip-bytes");
    });

    await new Promise<void>((resolve, reject) => {
      gitLabServer.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }

      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = "proxy-token";
      running = await startServerForContext(context);

      const resource = {
        type: "job-artifacts",
        params: { project_id: "group/project", job_id: "42" }
      };
      const token = createDownloadToken(
        { header: "private-token", token: "proxy-token" },
        resource,
        {
          secret: context.env.GITLAB_DOWNLOAD_TOKEN_SECRET,
          ttlSeconds: context.env.GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS
        }
      );
      const url = new URL(`${running.baseUrl}/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "42");
      url.searchParams.set("_token", token);

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/zip");
      expect(await response.text()).toBe("zip-bytes");
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("streams downloads from the configured MCP_SERVER_URL path prefix", async () => {
    const gitLabServer = createServer((req, res) => {
      expect(req.url).toBe("/api/v4/projects/group%2Fproject/jobs/43/artifacts");
      expect(req.headers["private-token"]).toBe("proxy-token");
      res.statusCode = 200;
      res.setHeader("content-type", "application/zip");
      res.end("prefixed-zip-bytes");
    });

    await new Promise<void>((resolve, reject) => {
      gitLabServer.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }

      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = "proxy-token";
      context.env.MCP_SERVER_URL = "https://mcp.example.com/gitlab-mcp";
      running = await startServerForContext(context);

      const resource = {
        type: "job-artifacts",
        params: { project_id: "group/project", job_id: "43" }
      };
      const token = createDownloadToken(
        { header: "private-token", token: "proxy-token" },
        resource,
        {
          secret: context.env.GITLAB_DOWNLOAD_TOKEN_SECRET,
          ttlSeconds: context.env.GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS
        }
      );
      const url = new URL(`${running.baseUrl}/gitlab-mcp/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "43");
      url.searchParams.set("_token", token);

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/zip");
      expect(await response.text()).toBe("prefixed-zip-bytes");
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});

describe("http app MCP OAuth", () => {
  it("exposes OAuth metadata and rejects unauthenticated MCP requests", async () => {
    const context = buildContext();
    context.env.GITLAB_MCP_OAUTH = true;
    context.env.MCP_SERVER_URL = "https://mcp.example.com";
    context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
    running = await startServerForContext(context);

    const protectedResource = await fetch(
      `${running.baseUrl}/.well-known/oauth-protected-resource`
    );
    const protectedBody = (await protectedResource.json()) as {
      authorization_servers?: string[];
      resource?: string;
    };

    expect(protectedResource.status).toBe(200);
    expect(protectedBody.resource).toBe("https://mcp.example.com/");
    expect(protectedBody.authorization_servers).toContain("https://mcp.example.com/");

    const authServer = await fetch(`${running.baseUrl}/.well-known/oauth-authorization-server`);
    const authBody = (await authServer.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    expect(authServer.status).toBe(200);
    expect(authBody.authorization_endpoint).toBe("https://mcp.example.com/authorize");
    expect(authBody.token_endpoint).toBe("https://mcp.example.com/token");

    const mcpResponse = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });

    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("advertises and serves prefixed OAuth endpoints when MCP_SERVER_URL has a path", async () => {
    const context = buildContext();
    context.env.GITLAB_MCP_OAUTH = true;
    context.env.MCP_SERVER_URL = "https://mcp.example.com/gitlab-mcp";
    context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
    running = await startServerForContext(context);

    const authServer = await fetch(`${running.baseUrl}/.well-known/oauth-authorization-server`);
    const authBody = (await authServer.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
      registration_endpoint?: string;
      revocation_endpoint?: string;
    };
    expect(authServer.status).toBe(200);
    expect(authBody.authorization_endpoint).toBe("https://mcp.example.com/gitlab-mcp/authorize");
    expect(authBody.token_endpoint).toBe("https://mcp.example.com/gitlab-mcp/token");
    expect(authBody.registration_endpoint).toBe("https://mcp.example.com/gitlab-mcp/register");
    expect(authBody.revocation_endpoint).toBe("https://mcp.example.com/gitlab-mcp/revoke");

    const pathSpecificAuthServer = await fetch(
      `${running.baseUrl}/.well-known/oauth-authorization-server/gitlab-mcp`
    );
    expect(pathSpecificAuthServer.status).toBe(200);
    await expect(pathSpecificAuthServer.json()).resolves.toMatchObject(authBody);

    const prefixedAuthServer = await fetch(
      `${running.baseUrl}/gitlab-mcp/.well-known/oauth-authorization-server`
    );
    expect(prefixedAuthServer.status).toBe(200);
    await expect(prefixedAuthServer.json()).resolves.toMatchObject(authBody);

    const protectedResource = await fetch(
      `${running.baseUrl}/.well-known/oauth-protected-resource/gitlab-mcp`
    );
    const protectedBody = (await protectedResource.json()) as {
      authorization_servers?: string[];
      resource?: string;
    };
    expect(protectedResource.status).toBe(200);
    expect(protectedBody.resource).toBe("https://mcp.example.com/gitlab-mcp");
    expect(protectedBody.authorization_servers).toContain("https://mcp.example.com/gitlab-mcp");

    const authorize = await fetch(
      `${running.baseUrl}/gitlab-mcp/authorize?client_id=client-1&redirect_uri=https%3A%2F%2Fclient.example.com%2Fcallback`
    );
    expect(authorize.status).toBe(400);

    const prefixedMcpResponse = await fetch(`${running.baseUrl}/gitlab-mcp/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(prefixedMcpResponse.status).toBe(401);
    expect(prefixedMcpResponse.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("validates direct PAT bypass before MCP OAuth session creation", async () => {
    const gitLabServer = createServer((req, res) => {
      const valid = req.url === "/api/v4/user" && req.headers["private-token"] === "valid-pat";
      res.statusCode = valid ? 200 : 401;
      res.end(valid ? "{}" : "unauthorized");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const address = gitLabServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Unexpected GitLab validation server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${address.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_MCP_OAUTH = true;
      context.env.MCP_SERVER_URL = "https://mcp.example.com";
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
      running = await startServerForContext(context);

      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "oauth-bypass-test", version: "0.0.1" }
        }
      });
      const invalid = await fetch(`${running.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "private-token": "invalid-pat"
        },
        body
      });
      expect(invalid.status).toBe(401);
      expect(running.pendingSessions.size).toBe(0);

      const valid = await fetch(`${running.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "private-token": "valid-pat"
        },
        body
      });
      expect(valid.status).toBe(200);
      expect(valid.headers.get("mcp-session-id")).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

describe("http app independent bearer authentication", () => {
  const gatewayToken = "independent-mcp-http-token-for-tests";

  it("protects Streamable HTTP before session creation", async () => {
    const context = buildContext();
    context.env.MCP_HTTP_AUTH_TOKEN = gatewayToken;
    running = await startServerForContext(context);

    const missing = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}'
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": "application/json"
      },
      body: '{"jsonrpc":"2.0"}'
    });
    expect(wrong.status).toBe(401);

    const authenticated = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json"
      },
      body: '{"jsonrpc":"2.0"'
    });
    expect(authenticated.status).toBe(400);
  });

  it("protects both legacy SSE endpoints", async () => {
    const context = buildContext();
    context.env.MCP_HTTP_AUTH_TOKEN = gatewayToken;
    context.env.SSE = true;
    running = await startServerForContext(context);

    const connect = await fetch(`${running.baseUrl}/sse`);
    expect(connect.status).toBe(401);

    const message = await fetch(`${running.baseUrl}/messages?sessionId=missing`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(message.status).toBe(400);
    await expect(message.text()).resolves.toContain("No transport");
  });
});

describe("http app Host and Origin policy", () => {
  it("rejects untrusted Host and Origin headers", async () => {
    const context = buildContext();
    context.env.MCP_ALLOWED_HOSTS = ["mcp.example.com"];
    context.env.MCP_ALLOWED_ORIGINS = ["https://client.example.com"];
    running = await startServerForContext(context);
    const baseUrl = running.baseUrl;

    const invalidHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${baseUrl}/healthz`,
        { headers: { host: "attacker.example.com" } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        }
      );
      request.on("error", reject);
      request.end();
    });
    expect(invalidHostStatus).toBe(403);

    const invalidOrigin = await fetch(`${baseUrl}/healthz`, {
      headers: {
        host: "mcp.example.com",
        origin: "https://attacker.example.com"
      }
    });
    expect(invalidOrigin.status).toBe(403);

    const allowed = await fetch(`${baseUrl}/healthz`, {
      headers: {
        host: "mcp.example.com:8443",
        origin: "https://client.example.com"
      }
    });
    expect(allowed.status).toBe(200);
  });

  it("fails closed for wildcard binds without a public host allowlist", () => {
    const context = buildContext();
    context.env.HTTP_HOST = "0.0.0.0";

    expect(() => setupMcpHttpApp({ context, env: context.env, logger: context.logger })).toThrow(
      "requires MCP_SERVER_URL or MCP_ALLOWED_HOSTS"
    );
  });
});

describe("http app pre-session IP rate limiting", () => {
  it("limits malformed requests before session creation", async () => {
    const context = buildContext();
    context.env.MAX_REQUESTS_PER_MINUTE_PER_IP = 2;
    running = await startServerForContext(context);

    for (let requestNumber = 0; requestNumber < 2; requestNumber += 1) {
      const response = await fetch(`${running.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0"'
      });
      expect(response.status).toBe(400);
    }

    const limited = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"'
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(running.pendingSessions.size).toBe(0);
  });

  it("ignores X-Forwarded-For unless trust proxy is explicit", async () => {
    const context = buildContext();
    context.env.MAX_REQUESTS_PER_MINUTE_PER_IP = 1;
    running = await startServerForContext(context);

    const first = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.1"
      },
      body: '{"jsonrpc":"2.0"'
    });
    expect(first.status).toBe(400);

    const second = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.2"
      },
      body: '{"jsonrpc":"2.0"'
    });
    expect(second.status).toBe(429);
  });

  it("uses the trusted proxy client IP when enabled", async () => {
    const context = buildContext();
    context.env.MAX_REQUESTS_PER_MINUTE_PER_IP = 1;
    context.env.MCP_TRUST_PROXY = true;
    running = await startServerForContext(context);

    for (const clientIp of ["198.51.100.1", "198.51.100.2"]) {
      const response = await fetch(`${running.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": clientIp
        },
        body: '{"jsonrpc":"2.0"'
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("http app stateless mode", () => {
  it("handles initialize without creating a stored session", async () => {
    const context = buildContext();
    context.env.OAUTH_STATELESS_MODE = true;
    running = await startServerForContext(context);

    const response = await fetch(`${running.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "stateless-test", version: "0.0.1" }
        }
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(running.pendingSessions.size).toBe(0);
  });
});
