import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import open from "open";
import pkceChallenge from "pkce-challenge";
import type { Logger } from "pino";

export interface GitLabOAuthConfig {
  clientId: string;
  clientSecret?: string;
  gitlabUrl: string;
  redirectUri: string;
  scopes: string[];
  tokenStoragePath?: string;
  autoOpenBrowser: boolean;
}

interface OAuthTokenData {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  created_at: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
}

export class GitLabOAuthManager {
  private readonly tokenPath: string;
  private readonly callbackTimeoutMs = 180_000;
  private inFlightTokenRequest: Promise<string | undefined> | null = null;

  constructor(
    private readonly config: GitLabOAuthConfig,
    private readonly logger: Logger
  ) {
    this.tokenPath =
      config.tokenStoragePath || path.join(os.homedir(), ".gitlab-mcp-oauth-token.json");
  }

  async getAccessToken(): Promise<string | undefined> {
    if (this.inFlightTokenRequest) {
      return this.inFlightTokenRequest;
    }

    this.inFlightTokenRequest = this.resolveAccessToken().finally(() => {
      this.inFlightTokenRequest = null;
    });

    return this.inFlightTokenRequest;
  }

  private async resolveAccessToken(): Promise<string | undefined> {
    const stored = await this.readStoredToken();
    if (stored && !isExpired(stored)) {
      return stored.access_token;
    }

    if (stored?.refresh_token) {
      try {
        const refreshed = await this.refreshToken(stored.refresh_token);
        await this.persistToken(refreshed);
        return refreshed.access_token;
      } catch (error) {
        this.logger.warn({ err: error }, "OAuth token refresh failed; running interactive auth");
      }
    }

    const token = await this.runInteractiveAuthorization();
    await this.persistToken(token);
    return token.access_token;
  }

  private async runInteractiveAuthorization(): Promise<OAuthTokenData> {
    const redirectUrl = new URL(this.config.redirectUri);
    if (redirectUrl.protocol !== "http:") {
      throw new Error("Only http redirect URI is supported for local OAuth callback server");
    }

    const challenge = await pkceChallenge();
    const state = randomBytes(16).toString("hex");
    const authorizationUrl = this.buildAuthorizationUrl({
      state,
      codeChallenge: challenge.code_challenge
    });

    if (this.config.autoOpenBrowser) {
      void open(authorizationUrl.toString()).catch((error) => {
        this.logger.warn(
          { err: error, authorizationUrl: authorizationUrl.toString() },
          "Failed to open browser"
        );
      });
    }

    this.logger.info(
      { authorizationUrl: authorizationUrl.toString() },
      "OAuth authorization required"
    );

    const code = await this.waitForAuthorizationCode(redirectUrl, state);
    return this.exchangeCodeForToken(code, challenge.code_verifier);
  }

  private buildAuthorizationUrl(options: { state: string; codeChallenge: string }): URL {
    const url = new URL("/oauth/authorize", this.config.gitlabUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", options.state);
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  private async waitForAuthorizationCode(redirectUrl: URL, expectedState: string): Promise<string> {
    const port = Number.parseInt(redirectUrl.port || "80", 10);
    const hostname = redirectUrl.hostname;
    const callbackPath = redirectUrl.pathname;

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const finalize = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      const server = http.createServer((req, res) => {
        const host = req.headers.host || `${hostname}:${port}`;
        const requestUrl = new URL(req.url || "/", `http://${host}`);
        if (requestUrl.pathname !== callbackPath) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        const code = requestUrl.searchParams.get("code");
        const state = requestUrl.searchParams.get("state");
        if (!code || state !== expectedState) {
          res.statusCode = 400;
          res.end("Invalid OAuth callback");
          finalize(() => {
            server.close();
            reject(new Error("Invalid OAuth callback state or missing code"));
          });
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          "<html><body><h3>Authentication complete. You can close this tab.</h3></body></html>"
        );
        finalize(() => {
          server.close();
          resolve(code);
        });
      });

      server.on("error", (error) => {
        finalize(() => reject(error));
      });

      const timeout = setTimeout(() => {
        finalize(() => {
          server.close();
          reject(new Error("OAuth callback timeout"));
        });
      }, this.callbackTimeoutMs);

      server.listen(port, hostname);
    });
  }

  private async exchangeCodeForToken(code: string, codeVerifier: string): Promise<OAuthTokenData> {
    const endpoint = new URL("/oauth/token", this.config.gitlabUrl);
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier
    });
    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    return this.fetchToken(endpoint, body);
  }

  private async refreshToken(refreshToken: string): Promise<OAuthTokenData> {
    const endpoint = new URL("/oauth/token", this.config.gitlabUrl);
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      redirect_uri: this.config.redirectUri
    });
    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }

    return this.fetchToken(endpoint, body);
  }

  private async fetchToken(endpoint: URL, body: URLSearchParams): Promise<OAuthTokenData> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`OAuth token endpoint failed: ${response.status} ${raw.slice(0, 500)}`);
    }

    const payload = (await response.json()) as TokenResponse;
    if (!payload.access_token) {
      throw new Error("OAuth response did not include access_token");
    }

    return {
      access_token: payload.access_token,
      token_type: payload.token_type || "Bearer",
      refresh_token: payload.refresh_token,
      expires_in: payload.expires_in,
      created_at: Date.now()
    };
  }

  private async persistToken(token: OAuthTokenData): Promise<void> {
    const dir = path.dirname(this.tokenPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  }

  private async readStoredToken(): Promise<OAuthTokenData | undefined> {
    try {
      const raw = await fs.readFile(this.tokenPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<OAuthTokenData>;
      if (!parsed.access_token) {
        return undefined;
      }
      return {
        access_token: parsed.access_token,
        token_type: parsed.token_type || "Bearer",
        refresh_token: parsed.refresh_token,
        expires_in: parsed.expires_in,
        created_at: parsed.created_at || 0
      };
    } catch {
      return undefined;
    }
  }
}

function isExpired(token: OAuthTokenData): boolean {
  if (!token.expires_in) {
    return false;
  }

  const expiresAt = token.created_at + token.expires_in * 1000;
  return Date.now() >= expiresAt - 5 * 60 * 1000;
}

export function deriveGitLabBaseUrl(apiUrl: string): string {
  const url = new URL(apiUrl);
  const prefix = url.pathname.replace(/\/api\/v4\/?$/, "");
  return new URL(prefix || "/", url.origin).toString().replace(/\/$/, "");
}
