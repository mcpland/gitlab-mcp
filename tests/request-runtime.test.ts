/**
 * Tests for helper functions exported or used internally by request-runtime.ts.
 * Since some functions are private, we test them indirectly or test the module-level
 * exported utilities that are accessible.
 *
 * For deeper testing we extract testable logic patterns.
 */
import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeEach, vi } from "vitest";

import type { AppEnv } from "../src/config/env.js";
import { GitLabClient } from "../src/lib/gitlab-client.js";
import { parseOauthScopes, resolveOauthScopes } from "../src/lib/oauth-scopes.js";
import { GitLabRequestRuntime } from "../src/lib/request-runtime.js";

const fetchMock = vi.fn();
const tempDirs: string[] = [];

vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/**
 * Replicate the parseTokenOutput logic for testing.
 * This matches the private function in request-runtime.ts.
 */
function parseTokenOutput(rawOutput: string): string | undefined {
  const output = rawOutput.trim();
  if (!output) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const token =
      getStringField(parsed, "token") ||
      getStringField(parsed, "access_token") ||
      getStringField(parsed, "private_token");
    if (token) {
      return token;
    }
  } catch {
    // Plain string output is valid.
  }

  return output.split(/\r?\n/, 1)[0]?.trim() || undefined;
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" }
  });
}

/**
 * Replicate resolveHomePath for testing.
 */
function resolveHomePath(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

/**
 * Replicate normalizeWarmupPath for testing.
 */
function normalizeWarmupPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/user";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Replicate resolveApiRoot for testing.
 */
function resolveApiRoot(url: URL): string | undefined {
  const match = url.pathname.match(/^(.*\/api\/v4)(?:\/|$)/);
  return match?.[1];
}

describe("parseTokenOutput", () => {
  it("returns undefined for empty string", () => {
    expect(parseTokenOutput("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseTokenOutput("   \n  ")).toBeUndefined();
  });

  it("parses plain text token", () => {
    expect(parseTokenOutput("glpat-abc123")).toBe("glpat-abc123");
  });

  it("parses plain text with trailing newline", () => {
    expect(parseTokenOutput("glpat-abc123\n")).toBe("glpat-abc123");
  });

  it("takes first line of multi-line output", () => {
    expect(parseTokenOutput("glpat-abc123\nsome debug info\nmore stuff")).toBe("glpat-abc123");
  });

  it("parses JSON with token field", () => {
    expect(parseTokenOutput('{"token": "glpat-from-json"}')).toBe("glpat-from-json");
  });

  it("parses JSON with access_token field", () => {
    expect(parseTokenOutput('{"access_token": "oauth-token-123"}')).toBe("oauth-token-123");
  });

  it("parses JSON with private_token field", () => {
    expect(parseTokenOutput('{"private_token": "private-123"}')).toBe("private-123");
  });

  it("prefers token field over access_token", () => {
    expect(parseTokenOutput('{"token": "primary", "access_token": "secondary"}')).toBe("primary");
  });

  it("ignores JSON with empty token fields", () => {
    expect(parseTokenOutput('{"token": "", "other": "value"}')).toBe(
      '{"token": "", "other": "value"}'
    );
  });

  it("ignores JSON with whitespace-only token fields", () => {
    expect(parseTokenOutput('{"token": "   "}')).toBe('{"token": "   "}');
  });

  it("trims whitespace from parsed token values", () => {
    expect(parseTokenOutput('{"token": "  trimmed  "}')).toBe("trimmed");
  });

  it("handles JSON with no recognized token fields", () => {
    const input = '{"unknown_field": "some-value"}';
    // Falls back to first line
    expect(parseTokenOutput(input)).toBe(input);
  });
});

describe("resolveHomePath", () => {
  it("returns undefined for empty input", () => {
    expect(resolveHomePath("")).toBeUndefined();
    expect(resolveHomePath(undefined)).toBeUndefined();
  });

  it("expands ~ to home directory", () => {
    const result = resolveHomePath("~/some/path");
    expect(result).toBeDefined();
    expect(result).not.toContain("~/");
    expect(result).toContain("some/path");
  });

  it("returns absolute paths unchanged", () => {
    expect(resolveHomePath("/absolute/path")).toBe("/absolute/path");
  });

  it("returns relative paths unchanged", () => {
    expect(resolveHomePath("relative/path")).toBe("relative/path");
  });
});

describe("normalizeWarmupPath", () => {
  it("returns /user for empty string", () => {
    expect(normalizeWarmupPath("")).toBe("/user");
  });

  it("returns /user for whitespace-only string", () => {
    expect(normalizeWarmupPath("   ")).toBe("/user");
  });

  it("preserves leading slash", () => {
    expect(normalizeWarmupPath("/custom")).toBe("/custom");
  });

  it("adds leading slash when missing", () => {
    expect(normalizeWarmupPath("custom")).toBe("/custom");
  });

  it("trims whitespace", () => {
    expect(normalizeWarmupPath("  /user  ")).toBe("/user");
  });
});

describe("resolveApiRoot", () => {
  it("extracts /api/v4 from standard URL", () => {
    const url = new URL("https://gitlab.example.com/api/v4/projects/1");
    expect(resolveApiRoot(url)).toBe("/api/v4");
  });

  it("extracts subpath /api/v4", () => {
    const url = new URL("https://example.com/gitlab/api/v4/projects");
    expect(resolveApiRoot(url)).toBe("/gitlab/api/v4");
  });

  it("returns undefined for non-API URLs", () => {
    const url = new URL("https://gitlab.example.com/group/project");
    expect(resolveApiRoot(url)).toBeUndefined();
  });

  it("matches when path ends with /api/v4", () => {
    const url = new URL("https://gitlab.example.com/api/v4/");
    expect(resolveApiRoot(url)).toBe("/api/v4");
  });
});

describe("parseOauthScopes", () => {
  it("parses space-separated scopes", () => {
    expect(parseOauthScopes("api read_user")).toEqual(["api", "read_user"]);
  });

  it("parses comma-separated scopes", () => {
    expect(parseOauthScopes("api,read_user,write_repository")).toEqual([
      "api",
      "read_user",
      "write_repository"
    ]);
  });

  it("handles mixed separators", () => {
    expect(parseOauthScopes("api, read_user write_repository")).toEqual([
      "api",
      "read_user",
      "write_repository"
    ]);
  });

  it("filters empty entries", () => {
    expect(parseOauthScopes("api,,read_user, ,write_repository")).toEqual([
      "api",
      "read_user",
      "write_repository"
    ]);
  });

  it("handles single scope", () => {
    expect(parseOauthScopes("api")).toEqual(["api"]);
  });

  it("handles empty string", () => {
    expect(parseOauthScopes("")).toEqual([]);
  });

  it("trims whitespace from scopes", () => {
    expect(parseOauthScopes("  api  ,  read_user  ")).toEqual(["api", "read_user"]);
  });
});

describe("resolveOauthScopes", () => {
  it("defaults to api when not in read-only mode", () => {
    expect(resolveOauthScopes(undefined, false)).toEqual(["api"]);
  });

  it("defaults to read_api when read-only mode is enabled", () => {
    expect(resolveOauthScopes(undefined, true)).toEqual(["read_api"]);
  });

  it("preserves explicitly configured scopes in read-only mode", () => {
    expect(resolveOauthScopes("api read_user", true)).toEqual(["api", "read_user"]);
  });
});

describe("GitLabRequestRuntime cookie warmup", () => {
  it("preserves authorization header mode during cookie warmup", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const runtime = new GitLabRequestRuntime(
      buildEnv({
        GITLAB_AUTH_COOKIE_PATH: await writeCookieFile()
      }),
      buildLogger()
    );

    await runtime.beforeRequest({
      url: new URL("https://gitlab.example.com/api/v4/projects"),
      method: "GET",
      headers: new Headers(),
      token: "oauth-token",
      authHeader: "authorization"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [warmupUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(warmupUrl)).toBe("https://gitlab.example.com/api/v4/user");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer oauth-token");
    expect(headers.has("PRIVATE-TOKEN")).toBe(false);
  });

  it("uses private-token mode during cookie warmup by default", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const runtime = new GitLabRequestRuntime(
      buildEnv({
        GITLAB_AUTH_COOKIE_PATH: await writeCookieFile()
      }),
      buildLogger()
    );

    await runtime.beforeRequest({
      url: new URL("https://gitlab.example.com/api/v4/projects"),
      method: "GET",
      headers: new Headers(),
      token: "pat-token"
    });

    const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("PRIVATE-TOKEN")).toBe("pat-token");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("uses job-token mode during cookie warmup when requested", async () => {
    fetchMock.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const runtime = new GitLabRequestRuntime(
      buildEnv({
        GITLAB_AUTH_COOKIE_PATH: await writeCookieFile()
      }),
      buildLogger()
    );

    await runtime.beforeRequest({
      url: new URL("https://gitlab.example.com/api/v4/projects"),
      method: "GET",
      headers: new Headers(),
      token: "job-token-123",
      authHeader: "job-token"
    });

    const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("JOB-TOKEN")).toBe("job-token-123");
    expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    expect(headers.has("Authorization")).toBe(false);
  });
});

describe("GitLabRequestRuntime OAuth retry", () => {
  it("force-refreshes an OAuth token and retries once after a 401", async () => {
    const oauthTokenPath = await writeOAuthTokenFile({
      access_token: "old-oauth-token",
      token_type: "Bearer",
      refresh_token: "refresh-token",
      expires_in: 3600,
      created_at: Date.now()
    });
    const seenAuthorizations: string[] = [];

    fetchMock.mockImplementation(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname === "/oauth/token") {
        return jsonResponse({
          access_token: "new-oauth-token",
          token_type: "Bearer",
          refresh_token: "new-refresh-token",
          expires_in: 3600
        });
      }

      seenAuthorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (seenAuthorizations.length === 1) {
        return jsonResponse({ message: "expired" }, 401);
      }

      return jsonResponse([{ id: 1, name: "project" }]);
    });

    const runtime = new GitLabRequestRuntime(
      buildEnv({
        GITLAB_USE_OAUTH: true,
        GITLAB_OAUTH_CLIENT_ID: "oauth-client-id",
        GITLAB_OAUTH_GITLAB_URL: "https://gitlab.example.com",
        GITLAB_OAUTH_TOKEN_PATH: oauthTokenPath
      }),
      buildLogger()
    );
    const client = new GitLabClient("https://gitlab.example.com/api/v4", undefined, {
      beforeRequest: (context) => runtime.beforeRequest(context)
    });

    await expect(client.listProjects()).resolves.toEqual([{ id: 1, name: "project" }]);
    expect(seenAuthorizations).toEqual(["Bearer old-oauth-token", "Bearer new-oauth-token"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry OAuth 401 responses for FormData request bodies", async () => {
    const oauthTokenPath = await writeOAuthTokenFile({
      access_token: "old-oauth-token",
      token_type: "Bearer",
      refresh_token: "refresh-token",
      expires_in: 3600,
      created_at: Date.now()
    });

    fetchMock.mockResolvedValue(jsonResponse({ message: "expired" }, 401));

    const runtime = new GitLabRequestRuntime(
      buildEnv({
        GITLAB_USE_OAUTH: true,
        GITLAB_OAUTH_CLIENT_ID: "oauth-client-id",
        GITLAB_OAUTH_GITLAB_URL: "https://gitlab.example.com",
        GITLAB_OAUTH_TOKEN_PATH: oauthTokenPath
      }),
      buildLogger()
    );
    const client = new GitLabClient("https://gitlab.example.com/api/v4", undefined, {
      beforeRequest: (context) => runtime.beforeRequest(context)
    });

    await expect(client.uploadMarkdown("project", "# Title", "readme.md")).rejects.toMatchObject({
      status: 401
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GitLabRequestRuntime OAuth group authorization", () => {
  it("authorizes a stored local OAuth token before the GitLab request", async () => {
    const oauthTokenPath = await writeOAuthTokenFile({
      access_token: "local-oauth-token",
      token_type: "Bearer",
      expires_in: 3600,
      created_at: Date.now()
    });
    const paths: string[] = [];
    fetchMock.mockImplementation(async (input: URL | string) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/api/v4/groups") {
        return Response.json([{ full_path: "my-org/team" }], {
          headers: { "x-next-page": "" }
        });
      }
      return jsonResponse([{ id: 1, name: "project" }]);
    });

    const runtime = new GitLabRequestRuntime(
      buildEnv({
        GITLAB_USE_OAUTH: true,
        GITLAB_OAUTH_CLIENT_ID: "oauth-client-id",
        GITLAB_OAUTH_GITLAB_URL: "https://gitlab.example.com",
        GITLAB_OAUTH_TOKEN_PATH: oauthTokenPath,
        GITLAB_OAUTH_ALLOWED_GROUPS: ["my-org"]
      }),
      buildLogger()
    );
    const client = new GitLabClient("https://gitlab.example.com/api/v4", undefined, {
      beforeRequest: (context) => runtime.beforeRequest(context)
    });

    await expect(client.listProjects()).resolves.toEqual([{ id: 1, name: "project" }]);
    expect(paths).toEqual(["/api/v4/groups", "/api/v4/projects"]);
  });

  it("fails closed before the request when local OAuth membership is absent", async () => {
    const oauthTokenPath = await writeOAuthTokenFile({
      access_token: "local-oauth-token",
      token_type: "Bearer",
      expires_in: 3600,
      created_at: Date.now()
    });
    fetchMock.mockResolvedValue(
      Response.json([{ full_path: "other-org" }], { headers: { "x-next-page": "" } })
    );
    const runtime = new GitLabRequestRuntime(
      buildEnv({
        GITLAB_USE_OAUTH: true,
        GITLAB_OAUTH_CLIENT_ID: "oauth-client-id",
        GITLAB_OAUTH_GITLAB_URL: "https://gitlab.example.com",
        GITLAB_OAUTH_TOKEN_PATH: oauthTokenPath,
        GITLAB_OAUTH_ALLOWED_GROUPS: ["my-org"]
      }),
      buildLogger()
    );
    const client = new GitLabClient("https://gitlab.example.com/api/v4", undefined, {
      beforeRequest: (context) => runtime.beforeRequest(context)
    });

    await expect(client.listProjects()).rejects.toThrow("not a member of an allowed GitLab group");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function buildEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    GITLAB_API_URL: "https://gitlab.example.com/api/v4",
    GITLAB_USE_OAUTH: false,
    GITLAB_MCP_OAUTH: false,
    GITLAB_OAUTH_CLIENT_ID: undefined,
    GITLAB_OAUTH_CLIENT_SECRET: undefined,
    GITLAB_OAUTH_GITLAB_URL: undefined,
    GITLAB_OAUTH_REDIRECT_URI: undefined,
    GITLAB_OAUTH_SCOPES: "api",
    GITLAB_OAUTH_ALLOWED_GROUPS: [],
    GITLAB_OAUTH_GROUP_CACHE_TTL_SECONDS: 60,
    GITLAB_OAUTH_GROUP_CACHE_MAX_ENTRIES: 1_000,
    GITLAB_OAUTH_TOKEN_PATH: undefined,
    GITLAB_OAUTH_AUTO_OPEN_BROWSER: false,
    GITLAB_AUTH_COOKIE_PATH: undefined,
    GITLAB_COOKIE_WARMUP_PATH: "/user",
    GITLAB_TOKEN_FILE: undefined,
    GITLAB_TOKEN_SCRIPT: undefined,
    GITLAB_TOKEN_SCRIPT_TIMEOUT_MS: 10_000,
    GITLAB_TOKEN_CACHE_SECONDS: 300,
    GITLAB_ALLOW_INSECURE_TOKEN_FILE: false,
    GITLAB_USER_AGENT: undefined,
    GITLAB_CLOUDFLARE_BYPASS: false,
    GITLAB_ACCEPT_LANGUAGE: undefined,
    GITLAB_HTTP_TIMEOUT_MS: 20_000,
    GITLAB_HTTP_MAX_RETRIES: 2,
    GITLAB_HTTP_RETRY_BASE_MS: 250,
    GITLAB_HTTP_RETRY_MAX_DELAY_MS: 10_000,
    GITLAB_MAX_LOCAL_FILE_BYTES: 250_000_000,
    GITLAB_LOCAL_FILE_ROOTS: [],
    GITLAB_DOWNLOAD_TOKEN_SECRET: undefined,
    GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS: 300,
    OAUTH_STATELESS_MODE: false,
    ...overrides
  } as AppEnv;
}

function buildLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  } as unknown as Logger;
}

async function writeCookieFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-mcp-cookies-"));
  tempDirs.push(dir);
  const cookiePath = path.join(dir, "cookies.txt");
  await fs.writeFile(
    cookiePath,
    ".gitlab.example.com\tTRUE\t/\tTRUE\t2147483647\tsession\tcookie-value\n",
    "utf8"
  );
  return cookiePath;
}

async function writeOAuthTokenFile(token: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-mcp-oauth-"));
  tempDirs.push(dir);
  const tokenPath = path.join(dir, "token.json");
  await fs.writeFile(tokenPath, JSON.stringify(token), "utf8");
  return tokenPath;
}
