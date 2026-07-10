import { createHash } from "node:crypto";
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
      MCP_METRICS_ENABLED: false,
      MCP_METRICS_AUTH_TOKEN: undefined,
      MCP_ALLOWED_HOSTS: [],
      MCP_ALLOWED_ORIGINS: [],
      GITLAB_API_URL: "https://gitlab.example.com/api/v4",
      GITLAB_API_URLS: ["https://gitlab.example.com/api/v4"],
      GITLAB_ALLOWED_HOSTS: [],
      GITLAB_POOL_MAX_SIZE: 100,
      GITLAB_PERSONAL_ACCESS_TOKEN: "test-token",
      GITLAB_USE_OAUTH: false,
      GITLAB_MCP_OAUTH: false,
      GITLAB_OAUTH_APP_ID: "test-gitlab-oauth-app",
      GITLAB_OAUTH_APP_SECRET: undefined,
      GITLAB_MCP_OAUTH_STATE_SECRET: Buffer.alloc(32, 7).toString("base64url"),
      GITLAB_MCP_OAUTH_STATE_SECRET_PREVIOUS: undefined,
      GITLAB_MCP_OAUTH_CLIENT_TTL_SECONDS: 2_592_000,
      GITLAB_MCP_OAUTH_CODE_TTL_SECONDS: 600,
      GITLAB_OAUTH_AUTO_OPEN_BROWSER: false,
      GITLAB_OAUTH_SCOPES: "api",
      GITLAB_OAUTH_ALLOWED_GROUPS: [],
      GITLAB_OAUTH_GROUP_CACHE_TTL_SECONDS: 60,
      GITLAB_OAUTH_GROUP_CACHE_MAX_ENTRIES: 1_000,
      GITLAB_READ_ONLY_MODE: false,
      GITLAB_PERMISSION_MODE: "full",
      GITLAB_ALLOWED_PROJECT_IDS: [],
      GITLAB_ALLOWED_TOOLS: [],
      GITLAB_TOOLSETS: [],
      GITLAB_ENABLE_COMPATIBILITY_ALIASES: false,
      GITLAB_ENABLE_CI_VARIABLE_TOOLS: false,
      GITLAB_ALLOW_CI_VARIABLE_VALUES: false,
      GITLAB_ENABLE_DEPENDENCY_PROXY_TOOLS: false,
      GITLAB_DISABLED_CAPABILITIES: [],
      GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: false,
      GITLAB_RESPONSE_MODE: "json",
      GITLAB_MAX_RESPONSE_BYTES: 200_000,
      GITLAB_MAX_LOCAL_FILE_BYTES: 250_000_000,
      GITLAB_LOCAL_FILE_ROOTS: [],
      GITLAB_DOWNLOAD_TOKEN_SECRET: "test-download-secret-with-32-characters",
      GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS: 300,
      GITLAB_HTTP_TIMEOUT_MS: 20_000,
      GITLAB_HTTP_MAX_RETRIES: 2,
      GITLAB_HTTP_RETRY_BASE_MS: 250,
      GITLAB_HTTP_RETRY_MAX_DELAY_MS: 10_000,
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
      permissionMode: "full",
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

  it("reports the effective permission mode", async () => {
    const context = buildContext();
    context.env.GITLAB_PERMISSION_MODE = "modify";
    running = await startServerForContext(context);

    const response = await fetch(`${running.baseUrl}/healthz`);
    const body = (await response.json()) as {
      permissionMode: string;
      readOnlyMode: boolean;
    };

    expect(body.permissionMode).toBe("modify");
    expect(body.readOnlyMode).toBe(false);
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
  it("does not expose a static server token to unauthenticated direct downloads", async () => {
    let upstreamRequests = 0;
    const gitLabServer = createServer((_req, res) => {
      upstreamRequests += 1;
      res.statusCode = 200;
      res.end("should-not-be-reached");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = "static-gitlab-token";
      context.env.MCP_HTTP_AUTH_TOKEN = "m".repeat(32);
      running = await startServerForContext(context);

      const url = new URL(`${running.baseUrl}/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "39");

      const response = await fetch(url);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("gitlab-mcp-downloads");
      expect(upstreamRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("uses a static server token only after independent MCP bearer authentication", async () => {
    let upstreamRequests = 0;
    const gitLabServer = createServer((req, res) => {
      upstreamRequests += 1;
      expect(req.headers["private-token"]).toBe("static-gitlab-token");
      res.statusCode = 200;
      res.end("authenticated-download");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = "static-gitlab-token";
      context.env.MCP_HTTP_AUTH_TOKEN = "m".repeat(32);
      running = await startServerForContext(context);

      const url = new URL(`${running.baseUrl}/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "39");

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${"m".repeat(32)}` }
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("authenticated-download");
      expect(upstreamRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("accepts canonical allowlist identities for encrypted and direct downloads", async () => {
    const requestPaths: string[] = [];
    const gitLabServer = createServer((req, res) => {
      requestPaths.push(req.url ?? "");
      expect(req.headers["private-token"]).toBe("static-gitlab-token");
      res.statusCode = 200;
      res.end("scoped-download");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = "static-gitlab-token";
      context.env.MCP_HTTP_AUTH_TOKEN = "m".repeat(32);
      context.env.GITLAB_ALLOWED_PROJECT_IDS = ["group/project", "123"];
      running = await startServerForContext(context);

      const identities = [
        ["group/project", "group%2Fproject"],
        ["group%2Fproject", "group%2Fproject"],
        ["group%252Fproject", "group%2Fproject"],
        ["%31%32%33", "123"]
      ] as const;

      for (const [projectId] of identities) {
        const resource = {
          type: "job-artifacts",
          params: { project_id: projectId, job_id: "42" }
        };
        const token = createDownloadToken(
          { header: "private-token", token: "static-gitlab-token" },
          resource,
          {
            secret: context.env.GITLAB_DOWNLOAD_TOKEN_SECRET,
            ttlSeconds: context.env.GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS
          }
        );
        const encryptedUrl = new URL(`${running.baseUrl}/downloads/job-artifacts`);
        encryptedUrl.searchParams.set("project_id", projectId);
        encryptedUrl.searchParams.set("job_id", "42");
        encryptedUrl.searchParams.set("_token", token);

        const encryptedResponse = await fetch(encryptedUrl);
        expect(encryptedResponse.status, `encrypted ${projectId}`).toBe(200);
        expect(await encryptedResponse.text()).toBe("scoped-download");

        const directUrl = new URL(`${running.baseUrl}/downloads/job-artifacts`);
        directUrl.searchParams.set("project_id", projectId);
        directUrl.searchParams.set("job_id", "42");
        const directResponse = await fetch(directUrl, {
          headers: { Authorization: `Bearer ${"m".repeat(32)}` }
        });
        expect(directResponse.status, `direct ${projectId}`).toBe(200);
        expect(await directResponse.text()).toBe("scoped-download");
      }

      expect(requestPaths).toEqual(
        identities.flatMap(([, canonicalProjectId]) => [
          `/api/v4/projects/${canonicalProjectId}/jobs/42/artifacts`,
          `/api/v4/projects/${canonicalProjectId}/jobs/42/artifacts`
        ])
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects non-allowlisted path and numeric identities for every download auth form", async () => {
    let upstreamRequests = 0;
    const gitLabServer = createServer((_req, res) => {
      upstreamRequests += 1;
      res.statusCode = 200;
      res.end("should-not-be-reached");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = "static-gitlab-token";
      context.env.MCP_HTTP_AUTH_TOKEN = "m".repeat(32);
      context.env.GITLAB_ALLOWED_PROJECT_IDS = ["group/project", "123"];
      running = await startServerForContext(context);

      for (const projectId of ["group/other", "0123"]) {
        const resource = {
          type: "job-artifacts",
          params: { project_id: projectId, job_id: "43" }
        };
        const token = createDownloadToken(
          { header: "private-token", token: "static-gitlab-token" },
          resource,
          {
            secret: context.env.GITLAB_DOWNLOAD_TOKEN_SECRET,
            ttlSeconds: context.env.GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS
          }
        );
        const encryptedUrl = new URL(`${running.baseUrl}/downloads/job-artifacts`);
        encryptedUrl.searchParams.set("project_id", projectId);
        encryptedUrl.searchParams.set("job_id", "43");
        encryptedUrl.searchParams.set("_token", token);
        expect((await fetch(encryptedUrl)).status, `encrypted ${projectId}`).toBe(400);

        const directUrl = new URL(`${running.baseUrl}/downloads/job-artifacts`);
        directUrl.searchParams.set("project_id", projectId);
        directUrl.searchParams.set("job_id", "43");
        expect(
          (
            await fetch(directUrl, {
              headers: { Authorization: `Bearer ${"m".repeat(32)}` }
            })
          ).status,
          `direct ${projectId}`
        ).toBe(400);
      }

      expect(upstreamRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("validates direct remote credentials before proxying a download", async () => {
    let downloadRequests = 0;
    const gitLabServer = createServer((req, res) => {
      if (req.url === "/api/v4/user") {
        res.statusCode = req.headers["private-token"] === "valid-remote-token" ? 200 : 401;
        res.end("{}");
        return;
      }

      downloadRequests += 1;
      expect(req.headers["private-token"]).toBe("valid-remote-token");
      res.statusCode = 200;
      res.end("remote-download");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

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
      running = await startServerForContext(context);

      const url = new URL(`${running.baseUrl}/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "40");

      const rejected = await fetch(url, {
        headers: { "Private-Token": "invalid-remote-token" }
      });
      expect(rejected.status).toBe(401);
      expect(downloadRequests).toBe(0);

      const accepted = await fetch(url, {
        headers: { "Private-Token": "valid-remote-token" }
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe("remote-download");
      expect(downloadRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("enforces MCP OAuth application and group policy on direct downloads", async () => {
    let downloadRequests = 0;
    let directPatValidationRequests = 0;
    const gitLabServer = createServer((req, res) => {
      const authorization = req.headers.authorization;
      if (req.url === "/oauth/token/info") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            scopes: ["api"],
            expires_in_seconds: 7_200,
            application: { uid: "test-gitlab-oauth-app" }
          })
        );
        return;
      }
      if (req.url?.startsWith("/api/v4/groups?")) {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-next-page", "");
        res.end(
          JSON.stringify([
            { full_path: authorization === "Bearer allowed-oauth-token" ? "my-org" : "other-org" }
          ])
        );
        return;
      }
      if (req.url === "/api/v4/user") {
        directPatValidationRequests += 1;
        res.statusCode = 200;
        res.end("{}");
        return;
      }

      downloadRequests += 1;
      expect(authorization).toBe("Bearer allowed-oauth-token");
      res.statusCode = 200;
      res.end("oauth-download");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab test server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
      context.env.GITLAB_MCP_OAUTH = true;
      context.env.GITLAB_OAUTH_ALLOWED_GROUPS = ["my-org"];
      context.env.MCP_SERVER_URL = "https://mcp.example.com";
      running = await startServerForContext(context);

      const url = new URL(`${running.baseUrl}/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "41");

      const rejectedGroup = await fetch(url, {
        headers: { Authorization: "Bearer denied-oauth-token" }
      });
      expect(rejectedGroup.status).toBe(401);
      expect(downloadRequests).toBe(0);

      const rejectedPat = await fetch(url, {
        headers: { "Private-Token": "direct-pat" }
      });
      expect(rejectedPat.status).toBe(401);
      expect(directPatValidationRequests).toBe(0);
      expect(downloadRequests).toBe(0);

      const accepted = await fetch(url, {
        headers: { Authorization: "Bearer allowed-oauth-token" }
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe("oauth-download");
      expect(downloadRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("bounds token buckets and stops token rotation at the client IP layer", async () => {
    let upstreamRequests = 0;
    const gitLabServer = createServer((req, res) => {
      if (req.url === "/api/v4/user") {
        res.statusCode = 200;
        res.end("{}");
        return;
      }

      upstreamRequests += 1;
      res.statusCode = 200;
      res.end("download");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

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
      context.env.MAX_REQUESTS_PER_MINUTE = 1;
      context.env.MAX_REQUESTS_PER_MINUTE_PER_IP = 3;
      running = await startServerForContext(context);

      const url = new URL(`${running.baseUrl}/downloads/job-artifacts`);
      url.searchParams.set("project_id", "group/project");
      url.searchParams.set("job_id", "40");
      const download = (token: string) =>
        fetch(url, {
          headers: { "Private-Token": token }
        });

      expect((await download("rotating-token-a")).status).toBe(200);
      const repeatedToken = await download("rotating-token-a");
      expect(repeatedToken.status).toBe(429);
      expect(repeatedToken.headers.get("retry-after")).toBeTruthy();
      expect((await download("rotating-token-b")).status).toBe(200);
      expect((await download("rotating-token-c")).status).toBe(429);
      expect(upstreamRequests).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("uses the shared canonical dynamic API URL policy", async () => {
    const gitLabServer = createServer((req, res) => {
      if (req.url === "/api/v4/user") {
        expect(req.headers["private-token"]).toBe("dynamic-token");
        res.statusCode = 200;
        res.end("{}");
        return;
      }

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
  it("rejects an OAuth bearer outside the configured GitLab groups", async () => {
    const gitLabServer = createServer((req, res) => {
      if (req.url === "/oauth/token/info") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            resource_owner_id: 42,
            scopes: ["api"],
            expires_in_seconds: 7_200,
            application: { uid: "test-gitlab-oauth-app" }
          })
        );
        return;
      }
      if (req.url?.startsWith("/api/v4/groups?")) {
        res.setHeader("content-type", "application/json");
        res.setHeader("x-next-page", "");
        res.end(JSON.stringify([{ full_path: "other-org" }]));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const address = gitLabServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Unexpected GitLab OAuth server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${address.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_MCP_OAUTH = true;
      context.env.GITLAB_OAUTH_ALLOWED_GROUPS = ["my-org"];
      context.env.MCP_SERVER_URL = "https://mcp.example.com";
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
      running = await startServerForContext(context);

      const response = await fetch(`${running.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer oauth-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "group-auth-test", version: "0.0.1" }
          }
        })
      });
      expect(response.status).toBe(401);
      expect(running.pendingSessions.size).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

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

  it("completes local DCR and fixed-callback OAuth flow on a prefixed issuer", async () => {
    let tokenExchangeCount = 0;
    let tokenRequestBody = "";
    const gitLabServer = createServer((req, res) => {
      if (req.url === "/oauth/token/info" && req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            scopes: ["api"],
            expires_in_seconds: 7_200,
            application: { uid: "test-gitlab-oauth-app" }
          })
        );
        return;
      }
      if (req.url !== "/oauth/token" || req.method !== "POST") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        tokenExchangeCount += 1;
        tokenRequestBody = Buffer.concat(chunks).toString("utf8");
        if (tokenExchangeCount > 1) {
          res.statusCode = 400;
          res.end("authorization code already used");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            access_token: "gitlab-access-token",
            refresh_token: "gitlab-refresh-token",
            token_type: "Bearer",
            expires_in: 7_200,
            scope: "api"
          })
        );
      });
    });
    await new Promise<void>((resolve) => gitLabServer.listen(0, "127.0.0.1", resolve));

    try {
      const gitLabAddress = gitLabServer.address();
      if (!gitLabAddress || typeof gitLabAddress === "string") {
        throw new Error("Unexpected GitLab OAuth server address");
      }
      const context = buildContext();
      context.env.GITLAB_API_URL = `http://127.0.0.1:${gitLabAddress.port}/api/v4`;
      context.env.GITLAB_API_URLS = [context.env.GITLAB_API_URL];
      context.env.GITLAB_MCP_OAUTH = true;
      context.env.MCP_SERVER_URL = "https://mcp.example.com/gitlab-mcp";
      context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
      running = await startServerForContext(context);

      const clientRedirectUri = "https://client.example.com/oauth/callback";
      const registration = await fetch(`${running.baseUrl}/gitlab-mcp/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [clientRedirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: "HTTP integration client"
        })
      });
      expect(registration.status).toBe(201);
      const registered = (await registration.json()) as { client_id: string };
      expect(registered.client_id).toMatch(/^v1\.client\./);

      const codeVerifier = "p".repeat(43);
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      const authorizeUrl = new URL(`${running.baseUrl}/gitlab-mcp/authorize`);
      authorizeUrl.search = new URLSearchParams({
        client_id: registered.client_id,
        redirect_uri: clientRedirectUri,
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        scope: "api",
        state: "client-state"
      }).toString();
      const authorize = await fetch(authorizeUrl, { redirect: "manual" });
      expect(authorize.status).toBe(302);
      const gitLabAuthorize = new URL(authorize.headers.get("location")!);
      expect(gitLabAuthorize.searchParams.get("client_id")).toBe("test-gitlab-oauth-app");
      expect(gitLabAuthorize.searchParams.get("redirect_uri")).toBe(
        "https://mcp.example.com/gitlab-mcp/callback"
      );

      const duplicateState = await fetch(
        `${running.baseUrl}/gitlab-mcp/callback?code=x&state=one&state=two`,
        { redirect: "manual" }
      );
      expect(duplicateState.status).toBe(400);

      const callback = await fetch(
        `${running.baseUrl}/gitlab-mcp/callback?${new URLSearchParams({
          code: "single-use-gitlab-code",
          state: gitLabAuthorize.searchParams.get("state")!
        }).toString()}`,
        { redirect: "manual" }
      );
      expect(callback.status).toBe(302);
      const clientCallback = new URL(callback.headers.get("location")!);
      expect(clientCallback.origin).toBe("https://client.example.com");
      expect(clientCallback.searchParams.get("state")).toBe("client-state");
      const proxyCode = clientCallback.searchParams.get("code");
      expect(proxyCode).toMatch(/^v1\.code\./);

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        code: proxyCode!,
        code_verifier: codeVerifier,
        redirect_uri: clientRedirectUri
      });
      const token = await fetch(`${running.baseUrl}/gitlab-mcp/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody
      });
      expect(token.status).toBe(200);
      const tokens = (await token.json()) as { access_token: string; refresh_token: string };
      expect(tokens.access_token).toBe("gitlab-access-token");
      expect(tokens.refresh_token).toMatch(/^v1\.refresh\./);
      const upstreamParams = new URLSearchParams(tokenRequestBody);
      expect(upstreamParams.get("code")).toBe("single-use-gitlab-code");
      expect(upstreamParams.get("redirect_uri")).toBe(
        "https://mcp.example.com/gitlab-mcp/callback"
      );
      expect(upstreamParams.get("code_verifier")).not.toBe(codeVerifier);

      const replay = await fetch(`${running.baseUrl}/gitlab-mcp/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody
      });
      expect(replay.status).toBe(400);
      await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
      expect(tokenExchangeCount).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        gitLabServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("disables PAT and job-token bypass when an OAuth group allowlist is configured", async () => {
    const context = buildContext();
    context.env.GITLAB_MCP_OAUTH = true;
    context.env.GITLAB_OAUTH_ALLOWED_GROUPS = ["my-org"];
    context.env.MCP_SERVER_URL = "https://mcp.example.com";
    context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
    running = await startServerForContext(context);

    for (const [headerName, headerValue] of [
      ["private-token", "otherwise-valid-pat"],
      ["job-token", "otherwise-valid-job-token"]
    ] as const) {
      const response = await fetch(`${running.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          [headerName]: headerValue
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "group-bypass-test", version: "0.0.1" }
          }
        })
      });
      expect(response.status).toBe(401);
    }
    expect(running.pendingSessions.size).toBe(0);
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

  it("fails closed for case variants of transport and download routes", async () => {
    const context = buildContext();
    context.env.MCP_HTTP_AUTH_TOKEN = gatewayToken;
    context.env.SSE = true;
    context.env.MCP_SERVER_URL = "https://mcp.example.com/gitlab-mcp";
    running = await startServerForContext(context);

    const requests = [
      fetch(`${running.baseUrl}/MCP`),
      fetch(`${running.baseUrl}/SSE`),
      fetch(`${running.baseUrl}/MESSAGES?sessionId=missing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      fetch(`${running.baseUrl}/DOWNLOADS/job-artifacts?project_id=group%2Fproject&job_id=42`),
      fetch(`${running.baseUrl}/gitlab-mcp/MCP`),
      fetch(`${running.baseUrl}/GITLAB-MCP/mcp`),
      fetch(
        `${running.baseUrl}/gitlab-mcp/DOWNLOADS/job-artifacts?project_id=group%2Fproject&job_id=42`
      )
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404);
      await response.body?.cancel();
    }
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

  it("does not let trusted-proxy source ports rotate the IP bucket", async () => {
    const context = buildContext();
    context.env.MAX_REQUESTS_PER_MINUTE_PER_IP = 1;
    context.env.MCP_TRUST_PROXY = true;
    running = await startServerForContext(context);

    for (const [clientIp, expectedStatus] of [
      ["198.51.100.7:41001", 400],
      ["198.51.100.7:41002", 429]
    ] as const) {
      const response = await fetch(`${running.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": clientIp
        },
        body: '{"jsonrpc":"2.0"'
      });
      expect(response.status).toBe(expectedStatus);
    }
  });

  it("normalizes trusted-proxy ports for OAuth endpoint limits", async () => {
    const context = buildContext();
    context.env.GITLAB_MCP_OAUTH = true;
    context.env.MCP_SERVER_URL = "https://mcp.example.com";
    context.env.GITLAB_PERSONAL_ACCESS_TOKEN = undefined;
    context.env.MCP_TRUST_PROXY = true;
    running = await startServerForContext(context);

    const register = (port: number) =>
      fetch(`${running!.baseUrl}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `198.51.100.8:${String(port)}`
        },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"]
        })
      });

    for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
      expect((await register(42_000 + requestNumber)).status).toBe(201);
    }
    expect((await register(43_000)).status).toBe(429);
  });

  it("applies the outer IP limit to legacy SSE messages", async () => {
    const context = buildContext();
    context.env.SSE = true;
    context.env.MAX_REQUESTS_PER_MINUTE_PER_IP = 1;
    context.env.MCP_TRUST_PROXY = true;
    running = await startServerForContext(context);

    for (const [clientIp, expectedStatus] of [
      ["198.51.100.9:44001", 400],
      ["198.51.100.9:44002", 429]
    ] as const) {
      const response = await fetch(`${running.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": clientIp
        },
        body: "{}"
      });
      expect(response.status).toBe(expectedStatus);
    }
  });
});

describe("http app Prometheus metrics", () => {
  it("does not expose /metrics by default", async () => {
    running = await startServer();
    const response = await fetch(`${running.baseUrl}/metrics`);
    expect(response.status).toBe(404);
  });

  it("enforces Host, Origin, and an independent metrics bearer", async () => {
    const context = buildContext();
    context.env.MCP_METRICS_ENABLED = true;
    context.env.MCP_METRICS_AUTH_TOKEN = "metrics-token-that-is-at-least-32-chars";
    context.env.MCP_ALLOWED_ORIGINS = ["https://monitoring.example.com"];
    running = await startServerForContext(context);

    await expect(fetch(`${running.baseUrl}/healthz`)).resolves.toMatchObject({ status: 200 });

    const missing = await fetch(`${running.baseUrl}/metrics/`);
    expect(missing.status).toBe(401);

    const rejectedOrigin = await fetch(`${running.baseUrl}/metrics`, {
      headers: {
        authorization: `Bearer ${context.env.MCP_METRICS_AUTH_TOKEN}`,
        origin: "https://attacker.example.com"
      }
    });
    expect(rejectedOrigin.status).toBe(403);

    const response = await fetch(`${running.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${context.env.MCP_METRICS_AUTH_TOKEN}` }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const output = await response.text();
    expect(output).toContain(
      'gitlab_mcp_http_requests_total{method="GET",route="healthz",status_code="200"} 1'
    );
    expect(output).toContain('gitlab_mcp_auth_failures_total{mode="metrics_bearer"} 1');
    expect(output).toContain(
      'gitlab_mcp_http_requests_total{method="GET",route="metrics",status_code="401"} 1'
    );
    expect(output).toContain('gitlab_mcp_sessions{state="streamable"} 0');
  });

  it("reuses MCP_HTTP_AUTH_TOKEN when no metrics-specific token is configured", async () => {
    const context = buildContext();
    context.env.MCP_METRICS_ENABLED = true;
    context.env.MCP_HTTP_AUTH_TOKEN = "shared-mcp-token-that-is-at-least-32-chars";
    running = await startServerForContext(context);

    const response = await fetch(`${running.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${context.env.MCP_HTTP_AUTH_TOKEN}` }
    });
    expect(response.status).toBe(200);
  });

  it("exports pre-session rate-limit rejections", async () => {
    const context = buildContext();
    context.env.MCP_METRICS_ENABLED = true;
    context.env.MCP_METRICS_AUTH_TOKEN = "metrics-token-that-is-at-least-32-chars";
    context.env.MAX_REQUESTS_PER_MINUTE_PER_IP = 1;
    running = await startServerForContext(context);
    const baseUrl = running.baseUrl;

    const malformed = () =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0"'
      });
    expect((await malformed()).status).toBe(400);
    expect((await malformed()).status).toBe(429);

    const response = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${context.env.MCP_METRICS_AUTH_TOKEN}` }
    });
    const output = await response.text();
    expect(output).toContain('gitlab_mcp_rate_limit_rejections_total{scope="ip"} 1');
    expect(output).toContain(
      'gitlab_mcp_http_requests_total{method="POST",route="mcp",status_code="429"} 1'
    );
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
