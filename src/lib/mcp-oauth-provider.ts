import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
  UnauthorizedClientError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  OAuthTokensSchema,
  type OAuthClientInformationFull,
  type OAuthTokenRevocationRequest,
  type OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Request, Response } from "express";

import { deriveGitLabBaseUrl } from "./oauth.js";
import { OAuthGroupAuthorizer } from "./oauth-group-authorizer.js";
import {
  hashMcpOAuthClientId,
  parseMcpOAuthKeyRing,
  StatelessMcpOAuthCodec
} from "./mcp-oauth-stateless.js";

const DEFAULT_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_CODE_TTL_SECONDS = 10 * 60;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 1_024;
const MAX_CLIENT_NAME_LENGTH = 128;
const MAX_CLIENT_ID_LENGTH = 4_096;
const MAX_CLIENT_STATE_LENGTH = 512;
const MAX_GITLAB_CODE_LENGTH = 2_048;
const MAX_SCOPE_LENGTH = 128;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const SUPPORTED_RESPONSE_TYPES = new Set(["code"]);
const SUPPORTED_TOKEN_AUTH_METHODS = new Set(["none", "client_secret_post"]);
const FORBIDDEN_REDIRECT_PROTOCOLS = new Set([
  "about:",
  "blob:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "mailto:",
  "tel:",
  "urn:",
  "ws:",
  "wss:"
]);

interface GitLabTokenInfo {
  scopes?: unknown;
  expires_in_seconds?: unknown;
  application?: { uid?: unknown } | null;
}

export interface GitLabMcpOAuthProviderOptions {
  applicationId: string;
  applicationSecret?: string;
  callbackUrl: string;
  stateSecret: string;
  previousStateSecret?: string;
  scopes: string[];
  resourceServerUrl: string;
  resourceName?: string;
  clientTtlSeconds?: number;
  codeTtlSeconds?: number;
  allowedGroups?: string[];
  groupCacheTtlMs?: number;
  groupCacheMaxEntries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GitLabMcpOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  readonly callbackUrl: URL;

  private readonly gitLabBaseUrl: string;
  private readonly applicationId: string;
  private readonly applicationSecret?: string;
  private readonly scopes: string[];
  private readonly resourceName: string;
  private readonly resourceServerUrl: string;
  private readonly codec: StatelessMcpOAuthCodec;
  private readonly groupAuthorizer?: OAuthGroupAuthorizer;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly clientStore: OAuthRegisteredClientsStore;

  constructor(apiUrl: string, options: GitLabMcpOAuthProviderOptions) {
    this.gitLabBaseUrl = deriveGitLabBaseUrl(apiUrl);
    this.applicationId = requireBoundedValue(options.applicationId, "GITLAB_OAUTH_APP_ID", 512);
    this.applicationSecret = options.applicationSecret
      ? requireBoundedValue(options.applicationSecret, "GITLAB_OAUTH_APP_SECRET", 1_024)
      : undefined;
    this.callbackUrl = validateCallbackUrl(options.callbackUrl);
    this.scopes = validateConfiguredScopes(options.scopes);
    this.resourceServerUrl = new URL(options.resourceServerUrl).href;
    this.resourceName = requireBoundedValue(
      options.resourceName ?? "GitLab MCP Server",
      "MCP_SERVER_NAME",
      MAX_CLIENT_NAME_LENGTH
    );
    this.timeoutMs = requireIntegerInRange(options.timeoutMs ?? 20_000, "timeoutMs", 500, 120_000);
    this.fetchImplementation = options.fetch ?? fetch;
    this.codec = new StatelessMcpOAuthCodec({
      keyRing: parseMcpOAuthKeyRing(options.stateSecret, options.previousStateSecret),
      clientTtlSeconds: requireIntegerInRange(
        options.clientTtlSeconds ?? DEFAULT_CLIENT_TTL_SECONDS,
        "clientTtlSeconds",
        600,
        31_536_000
      ),
      codeTtlSeconds: requireIntegerInRange(
        options.codeTtlSeconds ?? DEFAULT_CODE_TTL_SECONDS,
        "codeTtlSeconds",
        60,
        3_600
      ),
      now: options.now
    });
    this.groupAuthorizer = options.allowedGroups?.length
      ? new OAuthGroupAuthorizer({
          apiUrl,
          allowedGroups: options.allowedGroups,
          cacheTtlMs: options.groupCacheTtlMs ?? 60_000,
          cacheMaxEntries: options.groupCacheMaxEntries ?? 1_000,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImplementation
        })
      : undefined;
    this.clientStore = this.createClientStore();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clientStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    validateAuthorizationParams(params);
    this.validateResource(params.resource);
    const requestedScopes = params.scopes ?? [];
    if (
      requestedScopes.length > 0 &&
      (requestedScopes.some((scope) => !this.scopes.includes(scope)) ||
        this.scopes.some((scope) => !requestedScopes.includes(scope)))
    ) {
      throw new InvalidScopeError(
        "Requested scope must contain every scope required by this MCP server"
      );
    }

    const proxyCodeVerifier = randomBytes(32).toString("base64url");
    const proxyCodeChallenge = createHash("sha256")
      .update(proxyCodeVerifier, "utf8")
      .digest("base64url");
    const proxyState = this.codec.sealAuthorizationState({
      clientId: client.client_id,
      clientRedirectUri: params.redirectUri,
      clientCodeChallenge: params.codeChallenge,
      proxyCodeVerifier,
      clientState: params.state
    });

    const targetUrl = new URL(`${this.gitLabBaseUrl}/oauth/authorize`);
    targetUrl.search = new URLSearchParams({
      client_id: this.applicationId,
      response_type: "code",
      redirect_uri: this.callbackUrl.href,
      code_challenge: proxyCodeChallenge,
      code_challenge_method: "S256",
      state: proxyState,
      scope: this.scopes.join(" ")
    }).toString();
    res.redirect(302, targetUrl.href);
  }

  async challengeForAuthorizationCode(): Promise<string> {
    return "";
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    this.validateResource(resource);
    const code = this.codec.openAuthorizationCode(authorizationCode);
    if (!code) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (!safeStringEquals(hashMcpOAuthClientId(client.client_id), code.clientHash)) {
      throw new InvalidGrantError("Authorization code was issued to a different client");
    }
    if (!redirectUri || !safeStringEquals(redirectUri, code.clientRedirectUri)) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (!codeVerifier || !PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
      throw new InvalidGrantError("A valid PKCE code_verifier is required");
    }
    const computedChallenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
    if (!safeStringEquals(computedChallenge, code.clientCodeChallenge)) {
      throw new InvalidGrantError("PKCE code_verifier does not match the authorization request");
    }

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.applicationId,
      code: code.gitLabCode,
      redirect_uri: this.callbackUrl.href,
      code_verifier: code.proxyCodeVerifier
    });
    this.appendApplicationSecret(tokenParams);
    return this.requestTokens(
      tokenParams,
      "authorization code exchange",
      client.client_id,
      client.grant_types?.includes("refresh_token") ?? false
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    this.validateResource(resource);
    if (!client.grant_types?.includes("refresh_token")) {
      throw new UnauthorizedClientError("Client is not registered for the refresh_token grant");
    }
    if (
      scopes &&
      (scopes.some((scope) => !this.scopes.includes(scope)) ||
        this.scopes.some((scope) => !scopes.includes(scope)))
    ) {
      throw new InvalidScopeError(
        "Refresh scope must contain every scope required by this MCP server"
      );
    }
    const wrappedRefreshToken = this.codec.openRefreshToken(refreshToken);
    if (
      !wrappedRefreshToken ||
      !safeStringEquals(wrappedRefreshToken.clientHash, hashMcpOAuthClientId(client.client_id))
    ) {
      throw new InvalidGrantError("Invalid refresh token for this client");
    }
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.applicationId,
      refresh_token: wrappedRefreshToken.gitLabRefreshToken
    });
    this.appendApplicationSecret(params);
    if (scopes?.length) {
      params.set("scope", scopes.join(" "));
    }
    return this.requestTokens(params, "refresh token exchange", client.client_id, true);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let response: globalThis.Response;
    try {
      response = await this.fetchImplementation(`${this.gitLabBaseUrl}/oauth/token/info`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new ServerError("GitLab OAuth token validation is unavailable");
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new InvalidTokenError("Invalid or expired GitLab OAuth token");
    }

    let info: GitLabTokenInfo;
    try {
      info = (await response.json()) as GitLabTokenInfo;
    } catch {
      throw new ServerError("GitLab returned an invalid OAuth token information response");
    }
    const tokenScopes = info.scopes;
    if (info.application?.uid !== this.applicationId || !isStringArray(tokenScopes)) {
      throw new InvalidTokenError("OAuth token was not issued for this MCP server");
    }
    if (!this.scopes.every((scope) => tokenScopes.includes(scope))) {
      throw new InvalidTokenError("GitLab OAuth token is missing a required scope");
    }
    if (this.groupAuthorizer && !(await this.groupAuthorizer.authorize(token))) {
      throw new InvalidTokenError("OAuth token owner is not in an allowed GitLab group");
    }

    return {
      token,
      clientId: this.applicationId,
      scopes: tokenScopes,
      expiresAt:
        typeof info.expires_in_seconds === "number" && Number.isFinite(info.expires_in_seconds)
          ? Math.floor(Date.now() / 1_000) + info.expires_in_seconds
          : undefined
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    let token = request.token;
    let tokenTypeHint = request.token_type_hint;
    if (token.startsWith("v1.refresh.")) {
      const wrappedRefreshToken = this.codec.openRefreshToken(token);
      if (
        !wrappedRefreshToken ||
        !safeStringEquals(wrappedRefreshToken.clientHash, hashMcpOAuthClientId(client.client_id))
      ) {
        return;
      }
      token = wrappedRefreshToken.gitLabRefreshToken;
      tokenTypeHint = "refresh_token";
    }
    await this.revokeGitLabToken(token, tokenTypeHint, true);
  }

  async handleCallback(req: Request, res: Response): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const state = singleQueryValue(req.query.state);
    if (!state) {
      res.status(400).send("Missing or invalid OAuth state");
      return;
    }
    const pending = this.codec.openAuthorizationState(state);
    if (!pending) {
      res.status(400).send("Unknown or expired OAuth state");
      return;
    }

    const upstreamError = singleQueryValue(req.query.error);
    if (upstreamError) {
      const clientCallback = new URL(pending.clientRedirectUri);
      clientCallback.searchParams.set("error", normalizeOAuthError(upstreamError));
      const description = singleQueryValue(req.query.error_description);
      if (description) {
        clientCallback.searchParams.set("error_description", description.slice(0, 256));
      }
      if (pending.clientState !== undefined) {
        clientCallback.searchParams.set("state", pending.clientState);
      }
      res.redirect(302, clientCallback.href);
      return;
    }

    const gitLabCode = singleQueryValue(req.query.code);
    if (!gitLabCode || gitLabCode.length > MAX_GITLAB_CODE_LENGTH) {
      res.status(400).send("Missing or invalid GitLab authorization code");
      return;
    }

    try {
      const proxyCode = this.codec.sealAuthorizationCode({
        gitLabCode,
        clientHash: pending.clientHash,
        clientRedirectUri: pending.clientRedirectUri,
        clientCodeChallenge: pending.clientCodeChallenge,
        proxyCodeVerifier: pending.proxyCodeVerifier
      });
      const clientCallback = new URL(pending.clientRedirectUri);
      clientCallback.searchParams.set("code", proxyCode);
      if (pending.clientState !== undefined) {
        clientCallback.searchParams.set("state", pending.clientState);
      }
      res.redirect(302, clientCallback.href);
    } catch {
      res.status(500).send("Unable to complete OAuth callback");
    }
  }

  private createClientStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        if (clientId.length > MAX_CLIENT_ID_LENGTH) {
          return undefined;
        }
        return this.codec.openClient(clientId);
      },
      registerClient: async (client) => {
        const registered = validateClientRegistration(client, this.resourceName);
        let clientId: string;
        try {
          clientId = this.codec.sealClient(registered);
        } catch {
          throw new InvalidClientMetadataError("Registered client metadata is too large");
        }
        if (clientId.length > MAX_CLIENT_ID_LENGTH) {
          throw new InvalidClientMetadataError("Registered client metadata is too large");
        }
        return { ...registered, client_id: clientId };
      }
    };
  }

  private async requestTokens(
    params: URLSearchParams,
    operation: string,
    clientId: string,
    allowRefreshToken: boolean
  ): Promise<OAuthTokens> {
    let response: globalThis.Response;
    try {
      response = await this.fetchImplementation(`${this.gitLabBaseUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new ServerError(`GitLab OAuth ${operation} is unavailable`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new InvalidGrantError(`GitLab rejected the OAuth ${operation}`);
    }
    try {
      const tokens = OAuthTokensSchema.parse(await response.json());
      const returnedScopes = tokens.scope?.split(/[\s,]+/).filter(Boolean);
      if (
        returnedScopes &&
        !this.scopes.every((requiredScope) => returnedScopes.includes(requiredScope))
      ) {
        await this.revokeGitLabToken(tokens.access_token, "access_token", false);
        throw new InvalidGrantError("GitLab OAuth token is missing a required scope");
      }
      try {
        const authInfo = await this.verifyAccessToken(tokens.access_token);
        if (typeof authInfo.expiresAt !== "number" || authInfo.expiresAt <= Date.now() / 1_000) {
          throw new InvalidTokenError("GitLab returned an expired OAuth access token");
        }
      } catch (error) {
        await this.revokeGitLabToken(tokens.access_token, "access_token", false);
        if (error instanceof ServerError) {
          throw error;
        }
        throw new InvalidGrantError("GitLab returned an OAuth token that failed validation");
      }
      if (!tokens.refresh_token) {
        return tokens;
      }
      return allowRefreshToken
        ? {
            ...tokens,
            refresh_token: this.codec.sealRefreshToken(tokens.refresh_token, clientId)
          }
        : { ...tokens, refresh_token: undefined };
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        throw error;
      }
      throw new ServerError(`GitLab returned an invalid OAuth ${operation} response`);
    }
  }

  private appendApplicationSecret(params: URLSearchParams): void {
    if (this.applicationSecret) {
      params.set("client_secret", this.applicationSecret);
    }
  }

  private async revokeGitLabToken(
    token: string,
    tokenTypeHint: string | undefined,
    failClosed: boolean
  ): Promise<void> {
    const params = new URLSearchParams({
      token,
      client_id: this.applicationId
    });
    this.appendApplicationSecret(params);
    if (tokenTypeHint) {
      params.set("token_type_hint", tokenTypeHint);
    }

    try {
      const response = await this.fetchImplementation(`${this.gitLabBaseUrl}/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      await response.body?.cancel();
      if (!response.ok && failClosed) {
        throw new ServerError(`GitLab OAuth token revocation failed (${String(response.status)})`);
      }
    } catch (error) {
      if (failClosed) {
        if (error instanceof ServerError) {
          throw error;
        }
        throw new ServerError("GitLab OAuth token revocation is unavailable");
      }
    }
  }

  private validateResource(resource: URL | undefined): void {
    if (resource && resource.href !== this.resourceServerUrl) {
      throw new InvalidTargetError("OAuth resource does not match this MCP server");
    }
  }
}

export function createGitLabMcpOAuthProvider(
  apiUrl: string,
  options: GitLabMcpOAuthProviderOptions
): GitLabMcpOAuthProvider {
  return new GitLabMcpOAuthProvider(apiUrl, options);
}

function validateClientRegistration(
  client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  resourceName: string
): OAuthClientInformationFull {
  const redirectUris = [...new Set(client.redirect_uris)];
  if (
    redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS ||
    redirectUris.length !== client.redirect_uris.length
  ) {
    throw new InvalidClientMetadataError(
      `redirect_uris must contain between 1 and ${String(MAX_REDIRECT_URIS)} unique values`
    );
  }
  for (const redirectUri of redirectUris) {
    validateRedirectUri(redirectUri);
  }

  const grantTypes = client.grant_types ?? ["authorization_code", "refresh_token"];
  if (
    !grantTypes.includes("authorization_code") ||
    grantTypes.some((grantType) => !SUPPORTED_GRANT_TYPES.has(grantType))
  ) {
    throw new InvalidClientMetadataError("Only authorization_code and refresh_token are supported");
  }
  const responseTypes = client.response_types ?? ["code"];
  if (
    !responseTypes.includes("code") ||
    responseTypes.some((responseType) => !SUPPORTED_RESPONSE_TYPES.has(responseType))
  ) {
    throw new InvalidClientMetadataError("Only the code response type is supported");
  }
  const tokenEndpointAuthMethod =
    client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_post" : "none");
  if (!SUPPORTED_TOKEN_AUTH_METHODS.has(tokenEndpointAuthMethod)) {
    throw new InvalidClientMetadataError(
      "Only none and client_secret_post token authentication are supported"
    );
  }
  if (tokenEndpointAuthMethod === "client_secret_post" && !client.client_secret) {
    throw new InvalidClientMetadataError("A client secret is required for client_secret_post");
  }

  const clientName = client.client_name ?? resourceName;
  if (clientName.length === 0 || clientName.length > MAX_CLIENT_NAME_LENGTH) {
    throw new InvalidClientMetadataError(
      `client_name must not exceed ${String(MAX_CLIENT_NAME_LENGTH)} characters`
    );
  }
  const clientIdIssuedAt = Math.floor(Date.now() / 1_000);
  return {
    client_id: "pending",
    client_id_issued_at: clientIdIssuedAt,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    grant_types: grantTypes,
    response_types: responseTypes,
    client_name: clientName,
    client_secret: tokenEndpointAuthMethod === "none" ? undefined : client.client_secret,
    client_secret_expires_at:
      tokenEndpointAuthMethod === "none" ? undefined : client.client_secret_expires_at
  };
}

function validateAuthorizationParams(params: AuthorizationParams): void {
  validateRedirectUri(params.redirectUri);
  if (!PKCE_CHALLENGE_PATTERN.test(params.codeChallenge)) {
    throw new InvalidRequestError("code_challenge must be a valid S256 PKCE challenge");
  }
  if (params.state && params.state.length > MAX_CLIENT_STATE_LENGTH) {
    throw new InvalidRequestError(
      `state must not exceed ${String(MAX_CLIENT_STATE_LENGTH)} characters`
    );
  }
}

function validateRedirectUri(value: string): void {
  if (value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) {
    throw new InvalidClientMetadataError(
      `redirect_uri must not exceed ${String(MAX_REDIRECT_URI_LENGTH)} characters`
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidClientMetadataError("redirect_uri must be a valid URL");
  }
  if (url.hash || url.username || url.password) {
    throw new InvalidClientMetadataError(
      "redirect_uri must not contain a fragment or URL credentials"
    );
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new InvalidClientMetadataError(
      "HTTP redirect_uri values are allowed only for loopback hosts"
    );
  }
  if (FORBIDDEN_REDIRECT_PROTOCOLS.has(url.protocol)) {
    throw new InvalidClientMetadataError(
      "redirect_uri must use HTTPS, loopback HTTP, or a native-app custom scheme"
    );
  }
}

function validateCallbackUrl(value: string): URL {
  const callbackUrl = new URL(value);
  if (
    callbackUrl.username ||
    callbackUrl.password ||
    callbackUrl.search ||
    callbackUrl.hash ||
    (callbackUrl.protocol !== "https:" &&
      !(callbackUrl.protocol === "http:" && isLoopbackHostname(callbackUrl.hostname)))
  ) {
    throw new Error(
      "GitLab MCP OAuth callback URL must be HTTPS (or loopback HTTP) without credentials, query, or fragment"
    );
  }
  return callbackUrl;
}

function validateConfiguredScopes(scopes: string[]): string[] {
  const normalized = [...new Set(scopes)];
  if (
    normalized.length === 0 ||
    normalized.some(
      (scope) => scope.length === 0 || scope.length > MAX_SCOPE_LENGTH || /\s/.test(scope)
    )
  ) {
    throw new Error("GITLAB_OAUTH_SCOPES must contain at least one bounded scope value");
  }
  return normalized;
}

function requireBoundedValue(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${label} must contain between 1 and ${String(maxLength)} characters`);
  }
  return normalized;
}

function requireIntegerInRange(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be an integer between ${String(minimum)} and ${String(maximum)}`
    );
  }
  return value;
}

function normalizeOAuthError(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : "access_denied";
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}
