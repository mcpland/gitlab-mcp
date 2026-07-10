const GITLAB_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export type HttpRouteLabel =
  | "mcp"
  | "sse"
  | "messages"
  | "downloads"
  | "healthz"
  | "metrics"
  | "oauth"
  | "other";
export type RateLimitScope = "ip" | "session" | "download";
export type AuthFailureMode = "mcp_http_bearer" | "metrics_bearer" | "remote_gitlab" | "mcp_oauth";

interface CounterSample {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSample {
  method: string;
  statusCode: string;
  buckets: number[];
  count: number;
  sum: number;
}

export interface SessionGaugeValues {
  streamable: number;
  pending: number;
  sse: number;
}

export class MetricsRegistry {
  private readonly httpRequests = new Map<string, CounterSample>();
  private readonly rateLimitRejections = new Map<string, CounterSample>();
  private readonly authFailures = new Map<string, CounterSample>();
  private readonly gitLabLatency = new Map<string, HistogramSample>();

  recordHttpRequest(method: string, route: HttpRouteLabel, statusCode: number): void {
    const normalizedMethod = normalizeMethod(method);
    const normalizedStatus = normalizeStatusCode(statusCode);
    incrementCounter(this.httpRequests, `${normalizedMethod}\0${route}\0${normalizedStatus}`, {
      method: normalizedMethod,
      route,
      status_code: normalizedStatus
    });
  }

  incrementRateLimit(scope: RateLimitScope): void {
    incrementCounter(this.rateLimitRejections, scope, { scope });
  }

  incrementAuthFailure(mode: AuthFailureMode): void {
    incrementCounter(this.authFailures, mode, { mode });
  }

  observeGitLabRequest(
    method: string,
    statusCode: number | "network_error",
    durationMs: number
  ): void {
    const normalizedMethod = normalizeMethod(method);
    const normalizedStatus =
      statusCode === "network_error" ? statusCode : normalizeStatusCode(statusCode);
    const key = `${normalizedMethod}\0${normalizedStatus}`;
    let sample = this.gitLabLatency.get(key);
    if (!sample) {
      sample = {
        method: normalizedMethod,
        statusCode: normalizedStatus,
        buckets: GITLAB_LATENCY_BUCKETS.map(() => 0),
        count: 0,
        sum: 0
      };
      this.gitLabLatency.set(key, sample);
    }

    const seconds = Math.max(0, Number.isFinite(durationMs) ? durationMs / 1_000 : 0);
    sample.count += 1;
    sample.sum += seconds;
    for (let index = 0; index < GITLAB_LATENCY_BUCKETS.length; index += 1) {
      if (seconds <= (GITLAB_LATENCY_BUCKETS[index] ?? Number.POSITIVE_INFINITY)) {
        sample.buckets[index] = (sample.buckets[index] ?? 0) + 1;
      }
    }
  }

  render(sessions: SessionGaugeValues): string {
    const lines: string[] = [];
    appendCounter(
      lines,
      "gitlab_mcp_http_requests_total",
      "HTTP requests handled by the MCP server.",
      this.httpRequests
    );
    lines.push("# HELP gitlab_mcp_sessions Current MCP sessions by state.");
    lines.push("# TYPE gitlab_mcp_sessions gauge");
    for (const [state, value] of Object.entries(sessions)) {
      lines.push(`gitlab_mcp_sessions{state="${escapeLabel(state)}"} ${formatNumber(value)}`);
    }
    appendCounter(
      lines,
      "gitlab_mcp_rate_limit_rejections_total",
      "Requests rejected by rate limiting.",
      this.rateLimitRejections
    );
    appendCounter(
      lines,
      "gitlab_mcp_auth_failures_total",
      "Authentication failures by bounded authentication mode.",
      this.authFailures
    );
    lines.push("# HELP gitlab_mcp_gitlab_request_duration_seconds GitLab upstream fetch latency.");
    lines.push("# TYPE gitlab_mcp_gitlab_request_duration_seconds histogram");
    for (const sample of sortedSamples(this.gitLabLatency)) {
      const labels = `method="${escapeLabel(sample.method)}",status_code="${escapeLabel(sample.statusCode)}"`;
      for (let index = 0; index < GITLAB_LATENCY_BUCKETS.length; index += 1) {
        lines.push(
          `gitlab_mcp_gitlab_request_duration_seconds_bucket{${labels},le="${String(GITLAB_LATENCY_BUCKETS[index])}"} ${String(sample.buckets[index] ?? 0)}`
        );
      }
      lines.push(
        `gitlab_mcp_gitlab_request_duration_seconds_bucket{${labels},le="+Inf"} ${String(sample.count)}`
      );
      lines.push(
        `gitlab_mcp_gitlab_request_duration_seconds_sum{${labels}} ${formatNumber(sample.sum)}`
      );
      lines.push(
        `gitlab_mcp_gitlab_request_duration_seconds_count{${labels}} ${String(sample.count)}`
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

export function classifyHttpRoute(path: string, pathPrefix: string): HttpRouteLabel {
  const pathWithoutPrefix =
    pathPrefix && path.startsWith(`${pathPrefix}/`) ? path.slice(pathPrefix.length) : path;
  const normalizedPath =
    pathWithoutPrefix.length > 1 ? pathWithoutPrefix.replace(/\/$/, "") : pathWithoutPrefix;
  if (normalizedPath === "/mcp") return "mcp";
  if (normalizedPath === "/sse") return "sse";
  if (normalizedPath === "/messages") return "messages";
  if (normalizedPath.startsWith("/downloads/")) return "downloads";
  if (normalizedPath === "/healthz") return "healthz";
  if (normalizedPath === "/metrics") return "metrics";
  if (
    normalizedPath.startsWith("/.well-known/oauth-") ||
    ["/authorize", "/callback", "/token", "/register", "/revoke"].includes(normalizedPath)
  ) {
    return "oauth";
  }
  return "other";
}

function incrementCounter(
  target: Map<string, CounterSample>,
  key: string,
  labels: Record<string, string>
): void {
  const current = target.get(key);
  if (current) {
    current.value += 1;
  } else {
    target.set(key, { labels, value: 1 });
  }
}

function appendCounter(
  lines: string[],
  name: string,
  help: string,
  samples: Map<string, CounterSample>
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  for (const sample of sortedSamples(samples)) {
    const labels = Object.entries(sample.labels)
      .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
      .join(",");
    lines.push(`${name}{${labels}} ${String(sample.value)}`);
  }
}

function sortedSamples<T>(samples: Map<string, T>): T[] {
  return [...samples.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function normalizeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"].includes(normalized)
    ? normalized
    : "OTHER";
}

function normalizeStatusCode(statusCode: number): string {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? String(statusCode)
    : "other";
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}
