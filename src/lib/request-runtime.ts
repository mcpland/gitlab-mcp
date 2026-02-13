import { exec as execCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import fetchCookie from "fetch-cookie";
import type { Logger } from "pino";
import { Cookie, CookieJar } from "tough-cookie";

import type { AppEnv } from "../config/env.js";
import type { GitLabBeforeRequestContext, GitLabBeforeRequestResult } from "./gitlab-client.js";
import { deriveGitLabBaseUrl, GitLabOAuthManager } from "./oauth.js";

const execAsync = promisify(execCb);
const DEFAULT_BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

interface TokenState {
  value: string;
  expiresAt: number;
}

export class GitLabRequestRuntime {
  private readonly cookiePath?: string;
  private readonly warmupPath: string;
  private readonly tokenFilePath?: string;
  private readonly tokenScript?: string;
  private readonly oauthManager?: GitLabOAuthManager;

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
          scopes: parseOauthScopes(env.GITLAB_OAUTH_SCOPES),
          tokenStoragePath: resolveHomePath(env.GITLAB_OAUTH_TOKEN_PATH),
          autoOpenBrowser: env.GITLAB_OAUTH_AUTO_OPEN_BROWSER
        },
        this.logger
      );
    }
  }

  async beforeRequest(context: GitLabBeforeRequestContext): Promise<GitLabBeforeRequestResult> {
    await this.reloadCookiesIfChanged();

    const headers = new Headers(context.headers);
    this.applyCompatibilityHeaders(headers);

    let token = context.token;
    if (!token) {
      token = await this.resolveFallbackToken();
    }

    if (this.cookieJar) {
      await this.ensureSessionWarmup(context.url, headers, token);
    }

    return {
      headers,
      token,
      fetchImpl: this.fetchImpl
    };
  }

  private async resolveFallbackToken(): Promise<string | undefined> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.value;
    }

    if (this.oauthManager) {
      const token = await this.oauthManager.getAccessToken();
      if (token) {
        return token;
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
      return token;
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
      return token;
    }

    return undefined;
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

  private async ensureSessionWarmup(url: URL, headers: Headers, token?: string): Promise<void> {
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
    if (token && !warmupHeaders.has("PRIVATE-TOKEN")) {
      warmupHeaders.set("PRIVATE-TOKEN", token);
    }

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

function parseOauthScopes(rawScopes: string): string[] {
  return rawScopes
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}
