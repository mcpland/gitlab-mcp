import { readFileSync } from "node:fs";

import { z } from "zod";

import { loadDotenvFromArgv } from "./dotenv.js";

loadDotenvFromArgv();

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const DEFAULT_SERVER_VERSION = resolveDefaultServerVersion();

const responseModeSchema = z.enum(["json", "compact-json", "yaml"]);
const errorDetailModeSchema = z.enum(["safe", "full"]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: logLevelSchema.default("info"),
  MCP_SERVER_NAME: z.string().min(1).default("gitlab-mcp"),
  MCP_SERVER_VERSION: z.string().min(1).default(DEFAULT_SERVER_VERSION),
  GITLAB_API_URL: z.string().min(1).default("https://gitlab.com/api/v4"),
  GITLAB_PERSONAL_ACCESS_TOKEN: z.string().min(1).optional(),
  GITLAB_USE_OAUTH: z.enum(["true", "false"]).default("false"),
  GITLAB_OAUTH_CLIENT_ID: z.string().optional(),
  GITLAB_OAUTH_CLIENT_SECRET: z.string().optional(),
  GITLAB_OAUTH_GITLAB_URL: z.string().optional(),
  GITLAB_OAUTH_REDIRECT_URI: z.string().url().optional(),
  GITLAB_OAUTH_SCOPES: z.string().default("api"),
  GITLAB_OAUTH_TOKEN_PATH: z.string().optional(),
  GITLAB_OAUTH_AUTO_OPEN_BROWSER: z.enum(["true", "false"]).default("true"),
  GITLAB_READ_ONLY_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  GITLAB_ALLOWED_PROJECT_IDS: z.string().optional(),
  GITLAB_ALLOWED_TOOLS: z.string().optional(),
  GITLAB_DENIED_TOOLS_REGEX: z.string().optional(),
  GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: z.enum(["true", "false"]).default("false"),
  GITLAB_RESPONSE_MODE: responseModeSchema.default("json"),
  GITLAB_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(2_000_000).default(200_000),
  GITLAB_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  GITLAB_ERROR_DETAIL_MODE: errorDetailModeSchema.optional(),
  GITLAB_AUTH_COOKIE_PATH: z.string().optional(),
  GITLAB_COOKIE_WARMUP_PATH: z.string().default("/user"),
  GITLAB_CLOUDFLARE_BYPASS: z.enum(["true", "false"]).default("false"),
  GITLAB_USER_AGENT: z.string().optional(),
  GITLAB_ACCEPT_LANGUAGE: z.string().optional(),
  GITLAB_TOKEN_SCRIPT: z.string().optional(),
  GITLAB_TOKEN_SCRIPT_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  GITLAB_TOKEN_CACHE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  GITLAB_TOKEN_FILE: z.string().optional(),
  GITLAB_ALLOW_INSECURE_TOKEN_FILE: z.enum(["true", "false"]).default("false"),
  GITLAB_ALLOW_INSECURE_TLS: z.enum(["true", "false"]).default("false"),
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
  GITLAB_CA_CERT_PATH: z.string().optional(),
  HTTP_PROXY: z.string().optional(),
  HTTPS_PROXY: z.string().optional(),
  USE_GITLAB_WIKI: z.enum(["true", "false"]).default("true"),
  USE_MILESTONE: z.enum(["true", "false"]).default("true"),
  USE_PIPELINE: z.enum(["true", "false"]).default("true"),
  USE_RELEASE: z.enum(["true", "false"]).default("true"),
  REMOTE_AUTHORIZATION: z.enum(["true", "false"]).default("false"),
  ENABLE_DYNAMIC_API_URL: z.enum(["true", "false"]).default("false"),
  SESSION_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(86_400).default(3_600),
  MAX_SESSIONS: z.coerce.number().int().min(1).max(10_000).default(1_000),
  MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(300),
  HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3333),
  HTTP_JSON_ONLY: z.enum(["true", "false"]).default("false"),
  SSE: z.enum(["true", "false"]).default("false")
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment variables:\n${issues}`);
}

const data = parsed.data;
const rawApiUrls = parseCsv(data.GITLAB_API_URL);

if (rawApiUrls.length === 0) {
  throw new Error("GITLAB_API_URL must contain at least one URL");
}

const normalizedApiUrls = rawApiUrls.map((item) => {
  try {
    return normalizeApiUrl(item);
  } catch {
    throw new Error(`Invalid GITLAB_API_URL entry: '${item}'`);
  }
});

if (data.ENABLE_DYNAMIC_API_URL === "true" && data.REMOTE_AUTHORIZATION !== "true") {
  throw new Error("ENABLE_DYNAMIC_API_URL=true requires REMOTE_AUTHORIZATION=true");
}

if (data.GITLAB_USE_OAUTH === "true" && !data.GITLAB_OAUTH_CLIENT_ID) {
  throw new Error("GITLAB_USE_OAUTH=true requires GITLAB_OAUTH_CLIENT_ID");
}

if (data.SSE === "true" && data.REMOTE_AUTHORIZATION === "true") {
  throw new Error("SSE=true is not compatible with REMOTE_AUTHORIZATION=true");
}

if (data.NODE_TLS_REJECT_UNAUTHORIZED === "0" && data.GITLAB_ALLOW_INSECURE_TLS !== "true") {
  throw new Error(
    "NODE_TLS_REJECT_UNAUTHORIZED=0 requires GITLAB_ALLOW_INSECURE_TLS=true acknowledgment"
  );
}

export const env = {
  ...data,
  GITLAB_READ_ONLY_MODE: data.GITLAB_READ_ONLY_MODE,
  GITLAB_ERROR_DETAIL_MODE:
    data.GITLAB_ERROR_DETAIL_MODE ?? (data.NODE_ENV === "production" ? "safe" : "full"),
  GITLAB_USE_OAUTH: parseBoolean(data.GITLAB_USE_OAUTH, false),
  GITLAB_OAUTH_AUTO_OPEN_BROWSER: parseBoolean(data.GITLAB_OAUTH_AUTO_OPEN_BROWSER, true),
  GITLAB_CLOUDFLARE_BYPASS: parseBoolean(data.GITLAB_CLOUDFLARE_BYPASS, false),
  GITLAB_ALLOW_INSECURE_TOKEN_FILE: parseBoolean(data.GITLAB_ALLOW_INSECURE_TOKEN_FILE, false),
  GITLAB_ALLOW_INSECURE_TLS: parseBoolean(data.GITLAB_ALLOW_INSECURE_TLS, false),
  USE_GITLAB_WIKI: parseBoolean(data.USE_GITLAB_WIKI, true),
  USE_MILESTONE: parseBoolean(data.USE_MILESTONE, true),
  USE_PIPELINE: parseBoolean(data.USE_PIPELINE, true),
  USE_RELEASE: parseBoolean(data.USE_RELEASE, true),
  REMOTE_AUTHORIZATION: parseBoolean(data.REMOTE_AUTHORIZATION, false),
  ENABLE_DYNAMIC_API_URL: parseBoolean(data.ENABLE_DYNAMIC_API_URL, false),
  HTTP_JSON_ONLY: parseBoolean(data.HTTP_JSON_ONLY, false),
  SSE: parseBoolean(data.SSE, false),
  GITLAB_ALLOWED_PROJECT_IDS: parseCsv(data.GITLAB_ALLOWED_PROJECT_IDS),
  GITLAB_ALLOWED_TOOLS: parseCsv(data.GITLAB_ALLOWED_TOOLS),
  GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: parseBoolean(
    data.GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE,
    false
  ),
  GITLAB_API_URLS: normalizedApiUrls,
  GITLAB_API_URL: normalizedApiUrls[0] ?? normalizeApiUrl("https://gitlab.com/api/v4")
};

export type AppEnv = typeof env;

function normalizeApiUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!isHttpUrl(url)) {
    throw new Error(`Invalid protocol in GITLAB_API_URL entry: '${rawUrl}'`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/api/v4")) {
    url.pathname = pathname;
    return url.toString();
  }

  url.pathname = `${pathname}/api/v4`.replace(/\/\//g, "/");

  return url.toString();
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function resolveDefaultServerVersion(): string {
  try {
    const packageJsonUrl = new URL("../../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version.trim();
    }
  } catch {
    // Fallback to static version when package metadata is unavailable.
  }

  return "0.1.0";
}
