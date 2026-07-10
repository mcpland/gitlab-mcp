const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;
const LOOPBACK_HOSTNAMES = new Set<string>(LOCAL_HOSTNAMES);
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export interface HttpRequestPolicyConfig {
  HTTP_HOST: string;
  HTTP_PORT: number;
  MCP_SERVER_URL?: string;
  MCP_ALLOWED_HOSTS?: string[];
  MCP_ALLOWED_ORIGINS?: string[];
}

export interface HttpRequestPolicy {
  allowedHostnames: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
}

export function buildHttpRequestPolicy(config: HttpRequestPolicyConfig): HttpRequestPolicy {
  const allowedHostnames = new Set<string>(LOCAL_HOSTNAMES);
  const allowedOrigins = new Set<string>(
    LOCAL_HOSTNAMES.map((hostname) => buildHttpOrigin(hostname, config.HTTP_PORT))
  );
  const explicitHosts = config.MCP_ALLOWED_HOSTS ?? [];

  for (const entry of explicitHosts) {
    allowedHostnames.add(parseAllowedHostname(entry));
  }

  if (config.MCP_SERVER_URL) {
    const serverUrl = parseHttpUrl(config.MCP_SERVER_URL, "MCP_SERVER_URL");
    allowedHostnames.add(serverUrl.hostname.toLowerCase());
    allowedOrigins.add(serverUrl.origin.toLowerCase());
  }

  const bindHost = config.HTTP_HOST.trim().toLowerCase();
  if (WILDCARD_BIND_HOSTS.has(bindHost)) {
    if (!config.MCP_SERVER_URL && explicitHosts.length === 0) {
      throw new Error(
        "Non-local wildcard HTTP_HOST requires MCP_SERVER_URL or MCP_ALLOWED_HOSTS to prevent DNS rebinding"
      );
    }
  } else {
    const bindHostname = parseAllowedHostname(bindHost);
    allowedHostnames.add(bindHostname);
    allowedOrigins.add(buildHttpOrigin(bindHostname, config.HTTP_PORT));
  }

  for (const entry of config.MCP_ALLOWED_ORIGINS ?? []) {
    allowedOrigins.add(parseAllowedOrigin(entry));
  }

  return { allowedHostnames, allowedOrigins };
}

export function isRequestHostAllowed(
  hostHeader: string | undefined,
  policy: HttpRequestPolicy
): boolean {
  if (!hostHeader) {
    return false;
  }

  try {
    return policy.allowedHostnames.has(parseHostHeader(hostHeader));
  } catch {
    return false;
  }
}

export function isRequestOriginAllowed(
  originHeader: string | undefined,
  policy: HttpRequestPolicy
): boolean {
  if (!originHeader) {
    return true;
  }

  try {
    const origin = parseAllowedOrigin(originHeader);
    return isLoopbackOrigin(origin) || policy.allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
}

function parseAllowedHostname(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "*") {
    throw new Error(`Invalid MCP_ALLOWED_HOSTS entry: '${value}'`);
  }

  const authority = isUnbracketedIpv6Address(trimmed) ? `[${trimmed}]` : trimmed;
  const candidate = authority.includes("://") ? authority : `http://${authority}`;
  const url = parseHttpUrl(candidate, "MCP_ALLOWED_HOSTS");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid MCP_ALLOWED_HOSTS entry: '${value}'`);
  }

  return url.hostname.toLowerCase();
}

function isUnbracketedIpv6Address(value: string): boolean {
  return !value.includes("://") && !value.startsWith("[") && value.split(":").length > 2;
}

function parseHostHeader(value: string): string {
  const url = new URL(`http://${value}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid Host header");
  }
  return url.hostname.toLowerCase();
}

function parseAllowedOrigin(value: string): string {
  const url = parseHttpUrl(value.trim(), "MCP_ALLOWED_ORIGINS");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Invalid MCP_ALLOWED_ORIGINS entry: '${value}'`);
  }
  return url.origin.toLowerCase();
}

function parseHttpUrl(value: string, setting: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${setting} value: '${value}'`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid ${setting} protocol: '${url.protocol}'`);
  }
  return url;
}

function buildHttpOrigin(hostname: string, port: number): string {
  return `http://${hostname}:${String(port)}`;
}
