interface HttpAuthGuardConfig {
  HTTP_HOST: string;
  GITLAB_PERSONAL_ACCESS_TOKEN?: string;
  GITLAB_JOB_TOKEN?: string;
  GITLAB_USE_OAUTH?: boolean;
  GITLAB_TOKEN_SCRIPT?: string;
  GITLAB_TOKEN_FILE?: string;
  GITLAB_AUTH_COOKIE_PATH?: string;
  REMOTE_AUTHORIZATION: boolean;
  GITLAB_MCP_OAUTH?: boolean;
  MCP_HTTP_AUTH_TOKEN?: string;
}

export function assertSafeHttpAuthConfig(config: HttpAuthGuardConfig): void {
  const hasServerCredential = Boolean(
    config.GITLAB_PERSONAL_ACCESS_TOKEN ||
    config.GITLAB_JOB_TOKEN ||
    config.GITLAB_USE_OAUTH ||
    config.GITLAB_TOKEN_SCRIPT ||
    config.GITLAB_TOKEN_FILE ||
    config.GITLAB_AUTH_COOKIE_PATH
  );
  const hasInboundAuthentication = Boolean(
    config.REMOTE_AUTHORIZATION || config.GITLAB_MCP_OAUTH || config.MCP_HTTP_AUTH_TOKEN
  );

  if (hasInboundAuthentication || !hasServerCredential) {
    return;
  }

  if (isLocalBindHost(config.HTTP_HOST)) {
    return;
  }

  throw new Error(
    "Refusing to start HTTP server with server-side GitLab credentials on a non-local bind host. " +
      "Set MCP_HTTP_AUTH_TOKEN, REMOTE_AUTHORIZATION=true, or GITLAB_MCP_OAUTH=true for remote HTTP deployments, " +
      "or bind HTTP_HOST to 127.0.0.1/localhost."
  );
}

function isLocalBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
