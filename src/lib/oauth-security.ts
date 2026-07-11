import { parseMcpOAuthKeyRing } from "./mcp-oauth-stateless.js";

export interface McpOAuthSecurityConfig {
  enabled: boolean;
  serverUrl?: string;
  httpAuthToken?: string;
  remoteAuthorization?: boolean;
}

export interface McpOAuthProxyConfig {
  enabled: boolean;
  applicationId?: string;
  stateSecret?: string;
  previousStateSecret?: string;
}

export interface OAuthGroupSecurityConfig {
  allowedGroups: string[];
  localOAuthEnabled: boolean;
  mcpOAuthEnabled: boolean;
}

export function assertSafeMcpOAuthConfiguration(config: McpOAuthSecurityConfig): void {
  if (!config.enabled) {
    return;
  }
  if (config.remoteAuthorization) {
    throw new Error(
      "REMOTE_AUTHORIZATION=true cannot be combined with GITLAB_MCP_OAUTH=true; choose one per-request authentication mode"
    );
  }
  if (!config.serverUrl) {
    throw new Error("GITLAB_MCP_OAUTH=true requires MCP_SERVER_URL");
  }
  if (config.httpAuthToken) {
    throw new Error(
      "MCP_HTTP_AUTH_TOKEN cannot be combined with GITLAB_MCP_OAUTH=true because both use Authorization: Bearer"
    );
  }

  const issuer = new URL(config.serverUrl);
  if (issuer.username || issuer.password) {
    throw new Error("MCP_SERVER_URL must not include URL credentials when MCP OAuth is enabled");
  }
  if (issuer.protocol === "https:") {
    return;
  }
  if (issuer.protocol === "http:" && isLoopbackHostname(issuer.hostname)) {
    return;
  }
  throw new Error(
    "GITLAB_MCP_OAUTH requires an HTTPS MCP_SERVER_URL unless the issuer hostname is localhost or 127.0.0.1"
  );
}

export function assertMcpOAuthProxyConfiguration(config: McpOAuthProxyConfig): void {
  if (!config.enabled) {
    return;
  }
  if (!config.applicationId?.trim()) {
    throw new Error("GITLAB_MCP_OAUTH=true requires GITLAB_OAUTH_APP_ID");
  }
  if (!config.stateSecret) {
    throw new Error("GITLAB_MCP_OAUTH=true requires GITLAB_MCP_OAUTH_STATE_SECRET");
  }
  parseMcpOAuthKeyRing(config.stateSecret, config.previousStateSecret);
}

export function assertOAuthGroupConfiguration(config: OAuthGroupSecurityConfig): void {
  if (config.allowedGroups.length > 0 && !config.localOAuthEnabled && !config.mcpOAuthEnabled) {
    throw new Error(
      "GITLAB_OAUTH_ALLOWED_GROUPS requires GITLAB_USE_OAUTH=true or GITLAB_MCP_OAUTH=true"
    );
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1";
}
