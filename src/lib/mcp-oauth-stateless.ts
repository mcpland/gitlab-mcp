import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const TOKEN_VERSION = "v1";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 64;
const MAX_TOKEN_LENGTH = 8_192;
const FUTURE_CLOCK_SKEW_SECONDS = 60;
const HKDF_SALT = Buffer.from("gitlab-mcp-oauth-proxy-v1", "utf8");

type TokenPurpose = "client" | "state" | "code" | "refresh";

interface TimedPayload {
  v: 1;
  iat: number;
}

interface ClientPayload extends TimedPayload {
  nonce: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes?: string[];
  responseTypes?: string[];
  clientName?: string;
  clientSecret?: string;
  clientSecretExpiresAt?: number;
}

interface AuthorizationStatePayload extends TimedPayload {
  clientHash: string;
  clientRedirectUri: string;
  clientCodeChallenge: string;
  proxyCodeVerifier: string;
  clientState?: string;
}

interface AuthorizationCodePayload extends TimedPayload {
  gitLabCode: string;
  clientHash: string;
  clientRedirectUri: string;
  clientCodeChallenge: string;
  proxyCodeVerifier: string;
}

interface RefreshTokenPayload extends TimedPayload {
  gitLabRefreshToken: string;
  clientHash: string;
}

export interface McpOAuthKeyRing {
  current: Buffer;
  previous?: Buffer;
}

export interface StatelessMcpOAuthCodecOptions {
  keyRing: McpOAuthKeyRing;
  clientTtlSeconds: number;
  codeTtlSeconds: number;
  now?: () => number;
}

export interface AuthorizationStateInput {
  clientId: string;
  clientRedirectUri: string;
  clientCodeChallenge: string;
  proxyCodeVerifier: string;
  clientState?: string;
}

export interface AuthorizationCodeInput {
  gitLabCode: string;
  clientHash: string;
  clientRedirectUri: string;
  clientCodeChallenge: string;
  proxyCodeVerifier: string;
}

export function parseMcpOAuthKeyRing(
  currentSecret: string,
  previousSecret?: string
): McpOAuthKeyRing {
  const current = decodeSecret(currentSecret, "GITLAB_MCP_OAUTH_STATE_SECRET");
  const previous = previousSecret
    ? decodeSecret(previousSecret, "GITLAB_MCP_OAUTH_STATE_SECRET_PREVIOUS")
    : undefined;

  if (previous?.equals(current)) {
    throw new Error(
      "GITLAB_MCP_OAUTH_STATE_SECRET_PREVIOUS must differ from GITLAB_MCP_OAUTH_STATE_SECRET"
    );
  }

  return previous ? { current, previous } : { current };
}

export function hashMcpOAuthClientId(clientId: string): string {
  return createHash("sha256").update(clientId, "utf8").digest("base64url");
}

export class StatelessMcpOAuthCodec {
  private readonly keyRing: McpOAuthKeyRing;
  private readonly clientTtlSeconds: number;
  private readonly codeTtlSeconds: number;
  private readonly now: () => number;

  constructor(options: StatelessMcpOAuthCodecOptions) {
    this.keyRing = options.keyRing;
    this.clientTtlSeconds = options.clientTtlSeconds;
    this.codeTtlSeconds = options.codeTtlSeconds;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  sealClient(client: OAuthClientInformationFull): string {
    const payload: ClientPayload = {
      v: 1,
      iat: this.now(),
      nonce: randomBytes(16).toString("base64url"),
      redirectUris: client.redirect_uris,
      tokenEndpointAuthMethod: client.token_endpoint_auth_method ?? "client_secret_post"
    };
    if (client.grant_types) {
      payload.grantTypes = client.grant_types;
    }
    if (client.response_types) {
      payload.responseTypes = client.response_types;
    }
    if (client.client_name) {
      payload.clientName = client.client_name;
    }
    if (client.client_secret) {
      payload.clientSecret = client.client_secret;
    }
    if (client.client_secret_expires_at !== undefined) {
      payload.clientSecretExpiresAt = client.client_secret_expires_at;
    }

    return this.seal("client", payload);
  }

  openClient(clientId: string): OAuthClientInformationFull | undefined {
    const payload = this.open<ClientPayload>("client", clientId, this.clientTtlSeconds);
    if (!payload || !isClientPayload(payload)) {
      return undefined;
    }

    return {
      client_id: clientId,
      client_id_issued_at: payload.iat,
      redirect_uris: payload.redirectUris,
      token_endpoint_auth_method: payload.tokenEndpointAuthMethod,
      grant_types: payload.grantTypes,
      response_types: payload.responseTypes,
      client_name: payload.clientName,
      client_secret: payload.clientSecret,
      client_secret_expires_at: payload.clientSecretExpiresAt
    };
  }

  sealAuthorizationState(input: AuthorizationStateInput): string {
    const payload: AuthorizationStatePayload = {
      v: 1,
      iat: this.now(),
      clientHash: hashMcpOAuthClientId(input.clientId),
      clientRedirectUri: input.clientRedirectUri,
      clientCodeChallenge: input.clientCodeChallenge,
      proxyCodeVerifier: input.proxyCodeVerifier
    };
    if (input.clientState !== undefined) {
      payload.clientState = input.clientState;
    }
    return this.seal("state", payload);
  }

  openAuthorizationState(state: string): AuthorizationStatePayload | undefined {
    const payload = this.open<AuthorizationStatePayload>("state", state, this.codeTtlSeconds);
    return payload && isAuthorizationStatePayload(payload) ? payload : undefined;
  }

  sealAuthorizationCode(input: AuthorizationCodeInput): string {
    return this.seal("code", {
      v: 1,
      iat: this.now(),
      ...input
    } satisfies AuthorizationCodePayload);
  }

  openAuthorizationCode(code: string): AuthorizationCodePayload | undefined {
    const payload = this.open<AuthorizationCodePayload>("code", code, this.codeTtlSeconds);
    return payload && isAuthorizationCodePayload(payload) ? payload : undefined;
  }

  sealRefreshToken(gitLabRefreshToken: string, clientId: string): string {
    return this.seal("refresh", {
      v: 1,
      iat: this.now(),
      gitLabRefreshToken,
      clientHash: hashMcpOAuthClientId(clientId)
    } satisfies RefreshTokenPayload);
  }

  openRefreshToken(refreshToken: string): RefreshTokenPayload | undefined {
    const payload = this.open<RefreshTokenPayload>("refresh", refreshToken, this.clientTtlSeconds);
    return payload && isRefreshTokenPayload(payload) ? payload : undefined;
  }

  private seal<T extends TimedPayload>(purpose: TokenPurpose, payload: T): string {
    const key = deriveKey(this.keyRing.current, purpose);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const associatedData = Buffer.from(`${TOKEN_VERSION}:${purpose}`, "utf8");
    cipher.setAAD(associatedData);
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const blob = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
    const token = `${TOKEN_VERSION}.${purpose}.${blob.toString("base64url")}`;
    if (token.length > MAX_TOKEN_LENGTH) {
      throw new Error(`MCP OAuth ${purpose} token exceeds ${String(MAX_TOKEN_LENGTH)} bytes`);
    }
    return token;
  }

  private open<T extends TimedPayload>(
    purpose: TokenPurpose,
    token: string,
    ttlSeconds: number
  ): T | undefined {
    if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return undefined;
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || parts[1] !== purpose) {
      return undefined;
    }
    const encoded = parts[2];
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      return undefined;
    }
    const blob = Buffer.from(encoded, "base64url");
    if (blob.toString("base64url") !== encoded) {
      return undefined;
    }
    if (blob.length <= NONCE_BYTES + AUTH_TAG_BYTES) {
      return undefined;
    }
    const nonce = blob.subarray(0, NONCE_BYTES);
    const tag = blob.subarray(blob.length - AUTH_TAG_BYTES);
    const ciphertext = blob.subarray(NONCE_BYTES, blob.length - AUTH_TAG_BYTES);
    const associatedData = Buffer.from(`${TOKEN_VERSION}:${purpose}`, "utf8");

    for (const masterKey of availableKeys(this.keyRing)) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterKey, purpose), nonce);
        decipher.setAAD(associatedData);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        const payload = JSON.parse(plaintext.toString("utf8")) as unknown;
        if (isTimedPayload(payload) && isFresh(payload.iat, ttlSeconds, this.now())) {
          return payload as T;
        }
        return undefined;
      } catch {
        // The value may have been minted with the previous rotation key.
      }
    }

    return undefined;
  }
}

function decodeSecret(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^(?:[A-Za-z0-9_-]+={0,2}|[A-Za-z0-9+/]+={0,2})$/.test(normalized) ||
    normalized.replace(/=+$/, "").length % 4 === 1
  ) {
    throw new Error(`${label} must be valid base64 or base64url`);
  }

  const decoded = Buffer.from(normalized, "base64url");
  const canonicalInput = normalized.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (decoded.toString("base64url") !== canonicalInput) {
    throw new Error(`${label} must be valid base64 or base64url`);
  }
  if (decoded.length < MIN_SECRET_BYTES || decoded.length > MAX_SECRET_BYTES) {
    throw new Error(
      `${label} must decode to between ${String(MIN_SECRET_BYTES)} and ${String(MAX_SECRET_BYTES)} bytes`
    );
  }
  return decoded;
}

function deriveKey(masterKey: Buffer, purpose: TokenPurpose): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      HKDF_SALT,
      Buffer.from(`gitlab-mcp/oauth/${purpose}`, "utf8"),
      KEY_BYTES
    )
  );
}

function availableKeys(keyRing: McpOAuthKeyRing): Buffer[] {
  return keyRing.previous ? [keyRing.current, keyRing.previous] : [keyRing.current];
}

function isTimedPayload(value: unknown): value is TimedPayload {
  if (!isRecord(value)) {
    return false;
  }
  return value.v === 1 && Number.isInteger(value.iat) && (value.iat as number) >= 0;
}

function isFresh(issuedAt: number, ttlSeconds: number, now: number): boolean {
  return issuedAt <= now + FUTURE_CLOCK_SKEW_SECONDS && now - issuedAt <= ttlSeconds;
}

function isClientPayload(value: TimedPayload): value is ClientPayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.nonce) &&
    isStringArray(value.redirectUris) &&
    isNonEmptyString(value.tokenEndpointAuthMethod) &&
    isOptionalStringArray(value.grantTypes) &&
    isOptionalStringArray(value.responseTypes) &&
    isOptionalString(value.clientName) &&
    isOptionalString(value.clientSecret) &&
    (value.clientSecretExpiresAt === undefined ||
      (typeof value.clientSecretExpiresAt === "number" &&
        Number.isInteger(value.clientSecretExpiresAt) &&
        value.clientSecretExpiresAt >= 0))
  );
}

function isAuthorizationStatePayload(value: TimedPayload): value is AuthorizationStatePayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.clientHash) &&
    isNonEmptyString(value.clientRedirectUri) &&
    isNonEmptyString(value.clientCodeChallenge) &&
    isNonEmptyString(value.proxyCodeVerifier) &&
    isOptionalString(value.clientState)
  );
}

function isAuthorizationCodePayload(value: TimedPayload): value is AuthorizationCodePayload {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.gitLabCode) &&
    isNonEmptyString(value.clientHash) &&
    isNonEmptyString(value.clientRedirectUri) &&
    isNonEmptyString(value.clientCodeChallenge) &&
    isNonEmptyString(value.proxyCodeVerifier)
  );
}

function isRefreshTokenPayload(value: TimedPayload): value is RefreshTokenPayload {
  if (!isRecord(value)) {
    return false;
  }
  return isNonEmptyString(value.gitLabRefreshToken) && isNonEmptyString(value.clientHash);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}
