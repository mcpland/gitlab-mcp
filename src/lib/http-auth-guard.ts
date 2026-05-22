interface HttpAuthGuardConfig {
  HTTP_HOST: string;
  GITLAB_PERSONAL_ACCESS_TOKEN?: string;
  REMOTE_AUTHORIZATION: boolean;
}

export function assertSafeHttpAuthConfig(config: HttpAuthGuardConfig): void {
  if (config.REMOTE_AUTHORIZATION || !config.GITLAB_PERSONAL_ACCESS_TOKEN) {
    return;
  }

  if (isLocalBindHost(config.HTTP_HOST)) {
    return;
  }

  throw new Error(
    "Refusing to start HTTP server with GITLAB_PERSONAL_ACCESS_TOKEN on a non-local bind host. " +
      "Set REMOTE_AUTHORIZATION=true for remote HTTP deployments, or bind HTTP_HOST to 127.0.0.1/localhost."
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
