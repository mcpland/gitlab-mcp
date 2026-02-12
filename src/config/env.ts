import "dotenv/config";

import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

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
  MCP_SERVER_VERSION: z.string().min(1).default("0.1.0"),
  GITLAB_API_URL: z.string().url().default("https://gitlab.com/api/v4"),
  GITLAB_PERSONAL_ACCESS_TOKEN: z.string().min(1).optional(),
  GITLAB_READ_ONLY_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  GITLAB_ALLOWED_PROJECT_IDS: z.string().optional(),
  GITLAB_ALLOWED_TOOLS: z.string().optional(),
  GITLAB_DENIED_TOOLS_REGEX: z.string().optional(),
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
  HTTP_JSON_ONLY: z.enum(["true", "false"]).default("false")
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment variables:\n${issues}`);
}

const data = parsed.data;

if (data.ENABLE_DYNAMIC_API_URL === "true" && data.REMOTE_AUTHORIZATION !== "true") {
  throw new Error("ENABLE_DYNAMIC_API_URL=true requires REMOTE_AUTHORIZATION=true");
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
  GITLAB_ALLOWED_PROJECT_IDS: parseCsv(data.GITLAB_ALLOWED_PROJECT_IDS),
  GITLAB_ALLOWED_TOOLS: parseCsv(data.GITLAB_ALLOWED_TOOLS),
  GITLAB_API_URLS: parseCsv(data.GITLAB_API_URL).map((item) => normalizeApiUrl(item)),
  GITLAB_API_URL: normalizeApiUrl(data.GITLAB_API_URL)
};

export type AppEnv = typeof env;

function normalizeApiUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/api/v4")) {
    url.pathname = pathname;
    return url.toString();
  }

  url.pathname = `${pathname}/api/v4`.replace(/\/\//g, "/");

  return url.toString();
}
