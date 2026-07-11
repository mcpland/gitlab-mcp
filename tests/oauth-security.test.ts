import { describe, expect, it } from "vitest";

import {
  assertMcpOAuthProxyConfiguration,
  assertOAuthGroupConfiguration,
  assertSafeMcpOAuthConfiguration
} from "../src/lib/oauth-security.js";

describe("assertSafeMcpOAuthConfiguration", () => {
  it.each(["http://localhost:3333", "http://127.0.0.1:3333/gitlab-mcp", "https://mcp.example.com"])(
    "allows secure or loopback issuer %s",
    (serverUrl) => {
      expect(() => assertSafeMcpOAuthConfiguration({ enabled: true, serverUrl })).not.toThrow();
    }
  );

  it.each(["http://mcp.example.com", "http://192.168.1.20:3333", "http://[::1]:3333"])(
    "rejects non-loopback insecure issuer %s",
    (serverUrl) => {
      expect(() => assertSafeMcpOAuthConfiguration({ enabled: true, serverUrl })).toThrow(
        "HTTPS MCP_SERVER_URL"
      );
    }
  );

  it("rejects two authentication layers sharing Authorization Bearer", () => {
    expect(() =>
      assertSafeMcpOAuthConfiguration({
        enabled: true,
        serverUrl: "https://mcp.example.com",
        httpAuthToken: "m".repeat(32)
      })
    ).toThrow("MCP_HTTP_AUTH_TOKEN cannot be combined");
  });

  it("rejects combining remote authorization with MCP OAuth", () => {
    expect(() =>
      assertSafeMcpOAuthConfiguration({
        enabled: true,
        serverUrl: "https://mcp.example.com",
        remoteAuthorization: true
      })
    ).toThrow("REMOTE_AUTHORIZATION=true cannot be combined with GITLAB_MCP_OAUTH=true");
  });

  it("rejects issuer URLs containing credentials", () => {
    expect(() =>
      assertSafeMcpOAuthConfiguration({
        enabled: true,
        serverUrl: "https://user:password@mcp.example.com"
      })
    ).toThrow("must not include URL credentials");
  });
});

describe("assertMcpOAuthProxyConfiguration", () => {
  const validConfig = {
    enabled: true,
    applicationId: "gitlab-app",
    stateSecret: Buffer.alloc(32, 1).toString("base64url")
  };

  it("accepts a pre-registered app and a strong shared state secret", () => {
    expect(() => assertMcpOAuthProxyConfiguration(validConfig)).not.toThrow();
  });

  it("requires the pre-registered GitLab application ID", () => {
    expect(() =>
      assertMcpOAuthProxyConfiguration({ ...validConfig, applicationId: undefined })
    ).toThrow("GITLAB_OAUTH_APP_ID");
  });

  it("requires at least 32 decoded secret bytes", () => {
    expect(() =>
      assertMcpOAuthProxyConfiguration({
        ...validConfig,
        stateSecret: Buffer.alloc(16).toString("base64url")
      })
    ).toThrow("32");
  });
});

describe("assertOAuthGroupConfiguration", () => {
  it("rejects allowed groups when neither OAuth mode is enabled", () => {
    expect(() =>
      assertOAuthGroupConfiguration({
        allowedGroups: ["my-org"],
        localOAuthEnabled: false,
        mcpOAuthEnabled: false
      })
    ).toThrow("requires GITLAB_USE_OAUTH=true or GITLAB_MCP_OAUTH=true");
  });

  it.each([
    { localOAuthEnabled: true, mcpOAuthEnabled: false },
    { localOAuthEnabled: false, mcpOAuthEnabled: true }
  ])("accepts allowed groups with an OAuth mode enabled", (modes) => {
    expect(() =>
      assertOAuthGroupConfiguration({ allowedGroups: ["my-org"], ...modes })
    ).not.toThrow();
  });
});
