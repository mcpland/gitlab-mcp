export interface GitLabApiUrlPolicyConfig {
  GITLAB_API_URLS: string[];
  GITLAB_ALLOWED_HOSTS?: string[];
  GITLAB_POOL_MAX_SIZE: number;
}

export interface GitLabApiUrlPolicy {
  allowedApiUrlsByHost: ReadonlyMap<string, string>;
  resolve(value: string): string;
}

export function buildGitLabApiUrlPolicy(config: GitLabApiUrlPolicyConfig): GitLabApiUrlPolicy {
  const allowedApiUrlsByHost = new Map<string, string>();

  for (const value of config.GITLAB_API_URLS) {
    addAllowedApiUrl(allowedApiUrlsByHost, value, "GITLAB_API_URL");
  }
  for (const value of config.GITLAB_ALLOWED_HOSTS ?? []) {
    addAllowedApiUrl(allowedApiUrlsByHost, value, "GITLAB_ALLOWED_HOSTS");
  }

  if (allowedApiUrlsByHost.size > config.GITLAB_POOL_MAX_SIZE) {
    throw new Error(
      `Configured GitLab API host count (${allowedApiUrlsByHost.size}) exceeds GITLAB_POOL_MAX_SIZE (${config.GITLAB_POOL_MAX_SIZE})`
    );
  }

  return {
    allowedApiUrlsByHost,
    resolve(value: string): string {
      const selector = parseHttpUrl(value, "X-GitLab-API-URL");
      const apiUrl = allowedApiUrlsByHost.get(toHostPortKey(selector));
      if (!apiUrl) {
        throw new Error(`GitLab API URL host is not allowed: ${selector.host}`);
      }
      return apiUrl;
    }
  };
}

function addAllowedApiUrl(
  target: Map<string, string>,
  value: string,
  setting: "GITLAB_API_URL" | "GITLAB_ALLOWED_HOSTS"
): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${setting} contains an empty entry`);
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  const url = parseHttpUrl(candidate, setting);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${setting} entry must not include credentials, query, or fragment: '${value}'`
    );
  }

  const canonicalApiUrl = normalizeGitLabApiUrl(url);
  const host = toHostPortKey(url);
  if (!target.has(host)) {
    target.set(host, canonicalApiUrl);
  }
}

function toHostPortKey(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.toLowerCase()}:${port}`;
}

function normalizeGitLabApiUrl(url: URL): string {
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/api/v4")
    ? pathname
    : `${pathname}/api/v4`.replace(/\/\//g, "/");
  return url.toString();
}

function parseHttpUrl(value: string, setting: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${setting} value: '${value}'`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${setting} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${setting} must not include URL credentials`);
  }
  return url;
}
