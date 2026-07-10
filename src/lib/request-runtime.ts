import { exec as execCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import fetchCookie from "fetch-cookie";
import type { Logger } from "pino";
import { Cookie, CookieJar } from "tough-cookie";

import type { AppEnv } from "../config/env.js";
import type { GitLabAuthHeader } from "../types/auth.js";
import type { GitLabBeforeRequestContext, GitLabBeforeRequestResult } from "./gitlab-client.js";
import { resolveOauthScopes } from "./oauth-scopes.js";
import { deriveGitLabBaseUrl, GitLabOAuthManager } from "./oauth.js";
import { OAuthGroupAuthorizer } from "./oauth-group-authorizer.js";

const execAsync = promisify(execCb);
const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

interface TokenState {
  value: string;
  expiresAt: number;
}

interface ResolvedFallbackAuth {
  token?: string;
  authHeader?: GitLabAuthHeader;
  source?: "oauth" | "script" | "file";
}

export class GitLabRequestRuntime {
  private readonly cookiePath?: string;
  private readonly warmupPath: string;
  private readonly tokenFilePath?: string;
  private readonly tokenScript?: string;
  private readonly oauthManager?: GitLabOAuthManager;
  private readonly oauthGroupAuthorizer?: OAuthGroupAuthorizer;

  private fetchImpl: typeof fetch = fetch;
  private cookieJar: CookieJar | null = null;
  private cookieMtime = 0;
  private cookieReloadLock: Promise<void> | null = null;
  private readonly warmedApiRoots = new Set<string>();
  private cachedToken: TokenState | null = null;

  constructor(
    private readonly env: AppEnv,
    private readonly logger: Logger
  ) {
    this.cookiePath = resolveHomePath(env.GITLAB_AUTH_COOKIE_PATH);
    this.warmupPath = normalizeWarmupPath(env.GITLAB_COOKIE_WARMUP_PATH);
    this.tokenFilePath = resolveHomePath(env.GITLAB_TOKEN_FILE);
    this.tokenScript = env.GITLAB_TOKEN_SCRIPT?.trim() || undefined;

    if (env.GITLAB_USE_OAUTH && env.GITLAB_OAUTH_CLIENT_ID) {
      this.oauthManager = new GitLabOAuthManager(
        {
          clientId: env.GITLAB_OAUTH_CLIENT_ID,
          clientSecret: env.GITLAB_OAUTH_CLIENT_SECRET,
          gitlabUrl: env.GITLAB_OAUTH_GITLAB_URL || deriveGitLabBaseUrl(env.GITLAB_API_URL),
          redirectUri: env.GITLAB_OAUTH_REDIRECT_URI || "http://127.0.0.1:8765/callback",
          scopes: resolveOauthScopes(env.GITLAB_OAUTH_SCOPES, env.GITLAB_READ_ONLY_MODE),
          tokenStoragePath: resolveHomePath(env.GITLAB_OAUTH_TOKEN_PATH),
          autoOpenBrowser: env.GITLAB_OAUTH_AUTO_OPEN_BROWSER
        },
        this.logger
      );
      if (env.GITLAB_OAUTH_ALLOWED_GROUPS.length > 0) {
        this.oauthGroupAuthorizer = new OAuthGroupAuthorizer({
          apiUrl: env.GITLAB_API_URL,
          allowedGroups: env.GITLAB_OAUTH_ALLOWED_GROUPS,
          cacheTtlMs: env.GITLAB_OAUTH_GROUP_CACHE_TTL_SECONDS * 1_000,
          cacheMaxEntries: env.GITLAB_OAUTH_GROUP_CACHE_MAX_ENTRIES,
          timeoutMs: env.GITLAB_HTTP_TIMEOUT_MS
        });
      }
    }
  }

  async beforeRequest(context: GitLabBeforeRequestContext): Promise<GitLabBeforeRequestResult> {
    await this.reloadCookiesIfChanged();

    const headers = new Headers(context.headers);
    this.applyCompatibilityHeaders(headers);

    let token = context.token;
    let authHeader = context.authHeader;
    let authSource: ResolvedFallbackAuth["source"];
    if (!token) {
      const resolvedFallback = await this.resolveFallbackAuth();
      token = resolvedFallback.token;
      authSource = resolvedFallback.source;
      if (!authHeader && resolvedFallback.authHeader) {
        authHeader = resolvedFallback.authHeader;
      }
    }

    if (this.cookieJar) {
      await this.ensureSessionWarmup(context.url, headers, token, authHeader);
    }

    return {
      headers,
      token,
      authHeader,
      fetchImpl:
        authSource === "oauth" && token
          ? this.withOAuthRetry(this.fetchImpl, token)
          : this.fetchImpl
    };
  }

  private async resolveFallbackAuth(): Promise<ResolvedFallbackAuth> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return { token: this.cachedToken.value };
    }

    if (this.oauthManager) {
      const token = await this.resolveAuthorizedOAuthToken();
      if (token) {
        return {
          token,
          authHeader: "authorization",
          source: "oauth"
        };
      }
    }

    if (this.tokenScript) {
      const token = await this.loadTokenFromScript(this.tokenScript);
      if (token) {
        const ttlMs = this.env.GITLAB_TOKEN_CACHE_SECONDS * 1000;
        this.cachedToken = {
          value: token,
          expiresAt: now + ttlMs
        };
      }
      return { token, source: token ? "script" : undefined };
    }

    if (this.tokenFilePath) {
      const token = await this.loadTokenFromFile(this.tokenFilePath);
      if (token) {
        const ttlMs = this.env.GITLAB_TOKEN_CACHE_SECONDS * 1000;
        this.cachedToken = {
          value: token,
          expiresAt: now + ttlMs
        };
      }
      return { token, source: token ? "file" : undefined };
    }

    return {};
  }

  private withOAuthRetry(baseFetch: typeof fetch, initialToken: string): typeof fetch {
    return (async (input, init) => {
      const response = await baseFetch(input, init);
      if (response.status !== 401 || !this.oauthManager || isNonReplayableBody(init?.body)) {
        return response;
      }

      try {
        const refreshedToken = await this.resolveAuthorizedOAuthToken(true);
        if (!refreshedToken || refreshedToken === initialToken) {
          return response;
        }

        const retryInit: RequestInit = {
          ...init,
          headers: setAuthorizationHeader(init?.headers, refreshedToken)
        };
        return baseFetch(input, retryInit);
      } catch (error) {
        this.logger.warn({ err: error }, "OAuth token refresh after 401 failed");
        return response;
      }
    }) as typeof fetch;
  }

  private async resolveAuthorizedOAuthToken(forceRefresh = false): Promise<string | undefined> {
    if (!this.oauthManager) {
      return undefined;
    }

    const token = await this.oauthManager.getAccessToken({ forceRefresh });
    if (token && this.oauthGroupAuthorizer && !(await this.oauthGroupAuthorizer.authorize(token))) {
      throw new Error("OAuth access denied: user is not a member of an allowed GitLab group");
    }
    return token;
  }

  private async loadTokenFromScript(script: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync(script, {
        timeout: this.env.GITLAB_TOKEN_SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      });

      return parseTokenOutput(stdout);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to execute GITLAB_TOKEN_SCRIPT");
      return undefined;
    }
  }

  private async loadTokenFromFile(tokenFilePath: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(tokenFilePath);

      // Group/other bits on token files are rejected unless explicitly allowed.
      if ((stat.mode & 0o077) !== 0 && !this.env.GITLAB_ALLOW_INSECURE_TOKEN_FILE) {
        throw new Error(
          `Token file '${tokenFilePath}' is too permissive. Set chmod 600 or GITLAB_ALLOW_INSECURE_TOKEN_FILE=true.`
        );
      }

      const content = (await fs.readFile(tokenFilePath, "utf8")).trim();
      return parseTokenOutput(content);
    } catch (error) {
      this.logger.warn({ err: error, tokenFilePath }, "Failed to read GITLAB_TOKEN_FILE");
      return undefined;
    }
  }

  private applyCompatibilityHeaders(headers: Headers): void {
    const userAgent =
      this.env.GITLAB_USER_AGENT?.trim() ||
      (this.env.GITLAB_CLOUDFLARE_BYPASS ? DEFAULT_BROWSER_UA : undefined);
    if (userAgent && !headers.has("User-Agent")) {
      headers.set("User-Agent", userAgent);
    }

    if (this.env.GITLAB_CLOUDFLARE_BYPASS) {
      if (!headers.has("Accept-Language")) {
        headers.set("Accept-Language", this.env.GITLAB_ACCEPT_LANGUAGE || "en-US,en;q=0.9");
      }
      if (!headers.has("Cache-Control")) {
        headers.set("Cache-Control", "no-cache");
      }
      if (!headers.has("Pragma")) {
        headers.set("Pragma", "no-cache");
      }
    }
  }

  private async reloadCookiesIfChanged(): Promise<void> {
    if (!this.cookiePath) {
      return;
    }

    if (this.cookieReloadLock) {
      await this.cookieReloadLock;
      return;
    }

    this.cookieReloadLock = (async () => {
      try {
        const stat = await fs.stat(this.cookiePath!);
        if (stat.mtimeMs === this.cookieMtime) {
          return;
        }

        const cookieContent = await fs.readFile(this.cookiePath!, "utf8");
        const jar = createCookieJarFromNetscape(cookieContent);
        this.cookieJar = jar;
        this.fetchImpl = fetchCookie(fetch, jar) as unknown as typeof fetch;
        this.cookieMtime = stat.mtimeMs;
        this.warmedApiRoots.clear();
        this.logger.info({ cookiePath: this.cookiePath }, "Loaded auth cookies");
      } catch (error) {
        if (this.cookieJar) {
          this.logger.warn({ err: error, cookiePath: this.cookiePath }, "Clearing auth cookies");
        }
        this.cookieJar = null;
        this.fetchImpl = fetch;
        this.cookieMtime = 0;
        this.warmedApiRoots.clear();
      }
    })();

    try {
      await this.cookieReloadLock;
    } finally {
      this.cookieReloadLock = null;
    }
  }

  private async ensureSessionWarmup(
    url: URL,
    headers: Headers,
    token?: string,
    authHeader?: GitLabAuthHeader
  ): Promise<void> {
    const apiRoot = resolveApiRoot(url);
    if (!apiRoot) {
      return;
    }
    const apiRootKey = `${url.origin}${apiRoot}`;
    if (this.warmedApiRoots.has(apiRootKey)) {
      return;
    }

    const warmupUrl = new URL(`${apiRoot}${this.warmupPath}`, url.origin);
    const warmupHeaders = new Headers(headers);
    if (!warmupHeaders.has("Accept")) {
      warmupHeaders.set("Accept", "application/json");
    }
    attachAuthHeader(warmupHeaders, token, authHeader);

    try {
      const response = await this.fetchImpl(warmupUrl, {
        method: "GET",
        headers: warmupHeaders,
        redirect: "follow",
        signal: AbortSignal.timeout(Math.min(this.env.GITLAB_HTTP_TIMEOUT_MS, 12_000))
      });

      if (response.status < 500) {
        this.warmedApiRoots.add(apiRootKey);
      }
    } catch (error) {
      this.logger.debug({ err: error, warmupUrl: warmupUrl.toString() }, "Cookie warmup failed");
    }
  }
}

function resolveHomePath(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

function normalizeWarmupPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/user";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveApiRoot(url: URL): string | undefined {
  const match = url.pathname.match(/^(.*\/api\/v4)(?:\/|$)/);
  return match?.[1];
}

function createCookieJarFromNetscape(content: string): CookieJar {
  const jar = new CookieJar();
  const lines = content.split("\n");

  for (let raw of lines) {
    let httpOnly = false;
    if (raw.startsWith("#HttpOnly_")) {
      raw = raw.slice("#HttpOnly_".length);
      httpOnly = true;
    }

    if (!raw.trim() || raw.startsWith("#")) {
      continue;
    }

    const parts = raw.split("\t");
    if (parts.length < 7) {
      continue;
    }

    const domain = parts[0];
    const cookiePath = parts[2];
    const secure = parts[3];
    const expires = parts[4];
    const name = parts[5];
    const value = parts[6];
    if (
      domain === undefined ||
      cookiePath === undefined ||
      secure === undefined ||
      expires === undefined ||
      name === undefined ||
      value === undefined
    ) {
      continue;
    }
    const secureFlag = secure === "TRUE" ? "; Secure" : "";
    const httpOnlyFlag = httpOnly ? "; HttpOnly" : "";
    const expiresFlag =
      expires === "0"
        ? ""
        : `; Expires=${new Date(Number.parseInt(expires, 10) * 1000).toUTCString()}`;

    const cookieString = `${name}=${value}; Domain=${domain}; Path=${cookiePath}${secureFlag}${httpOnlyFlag}${expiresFlag}`;
    const cookie = Cookie.parse(cookieString);
    if (!cookie) {
      continue;
    }

    const normalizedDomain = domain.startsWith(".") ? domain.slice(1) : domain;
    const targetUrl = `${secure === "TRUE" ? "https" : "http"}://${normalizedDomain}`;
    try {
      jar.setCookieSync(cookie, targetUrl);
    } catch {
      // ignore invalid cookies from external files
    }
  }

  return jar;
}

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

function attachAuthHeader(headers: Headers, token?: string, authHeader?: GitLabAuthHeader): void {
  if (!token) {
    return;
  }

  if (authHeader === "authorization" || headers.has("Authorization")) {
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return;
  }

  if (authHeader === "job-token" || headers.has("JOB-TOKEN")) {
    if (!headers.has("JOB-TOKEN")) {
      headers.set("JOB-TOKEN", token);
    }
    return;
  }

  if (!headers.has("PRIVATE-TOKEN")) {
    headers.set("PRIVATE-TOKEN", token);
  }
}

function setAuthorizationHeader(headers: HeadersInit | undefined, token: string): Headers {
  const nextHeaders = new Headers(headers);
  nextHeaders.set("Authorization", `Bearer ${token}`);
  nextHeaders.delete("PRIVATE-TOKEN");
  nextHeaders.delete("JOB-TOKEN");
  return nextHeaders;
}

function isNonReplayableBody(body: BodyInit | null | undefined): boolean {
  return body instanceof FormData || body instanceof ReadableStream;
}
