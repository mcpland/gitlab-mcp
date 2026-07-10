import { describe, expect, it } from "vitest";

import { classifyHttpRoute, MetricsRegistry } from "../src/lib/metrics.js";

describe("MetricsRegistry", () => {
  it("renders bounded HTTP, session, rejection, auth, and GitLab latency metrics", () => {
    const metrics = new MetricsRegistry();
    metrics.recordHttpRequest("POST", "mcp", 200);
    metrics.incrementRateLimit("ip");
    metrics.incrementAuthFailure("remote_gitlab");
    metrics.observeGitLabRequest("GET", 200, 25);
    metrics.observeGitLabRequest("GET", "network_error", 2_000);

    const output = metrics.render({ streamable: 2, pending: 1, sse: 0 });
    expect(output).toContain(
      'gitlab_mcp_http_requests_total{method="POST",route="mcp",status_code="200"} 1'
    );
    expect(output).toContain('gitlab_mcp_sessions{state="streamable"} 2');
    expect(output).toContain('gitlab_mcp_rate_limit_rejections_total{scope="ip"} 1');
    expect(output).toContain('gitlab_mcp_auth_failures_total{mode="remote_gitlab"} 1');
    expect(output).toContain(
      'gitlab_mcp_gitlab_request_duration_seconds_count{method="GET",status_code="200"} 1'
    );
    expect(output).toContain('status_code="network_error"');
    expect(output).not.toContain("token");
    expect(output).not.toContain("project_id");
  });

  it("normalizes unexpected methods and status codes", () => {
    const metrics = new MetricsRegistry();
    metrics.recordHttpRequest("CUSTOM", "other", 999);
    expect(metrics.render({ streamable: 0, pending: 0, sse: 0 })).toContain(
      'method="OTHER",route="other",status_code="other"'
    );
  });
});

describe("classifyHttpRoute", () => {
  it.each([
    ["/mcp", "", "mcp"],
    ["/mcp/", "", "mcp"],
    ["/gitlab/mcp", "/gitlab", "mcp"],
    ["/gitlab/mcp/", "/gitlab", "mcp"],
    ["/downloads/job-artifacts", "", "downloads"],
    ["/metrics/", "", "metrics"],
    ["/authorize/", "", "oauth"],
    ["/projects/secret-project", "", "other"],
    ["/.well-known/oauth-authorization-server", "", "oauth"],
    ["/gitlab/callback", "/gitlab", "oauth"]
  ])("maps %s to a bounded route label", (path, prefix, expected) => {
    expect(classifyHttpRoute(path, prefix)).toBe(expected);
  });
});
