import { describe, expect, it } from "vitest";

import {
  buildHttpRequestPolicy,
  isRequestHostAllowed,
  isRequestOriginAllowed
} from "../src/lib/http-request-policy.js";

describe("HTTP request origin policy", () => {
  it("derives public Host and Origin entries from MCP_SERVER_URL", () => {
    const policy = buildHttpRequestPolicy({
      HTTP_HOST: "0.0.0.0",
      HTTP_PORT: 3333,
      MCP_SERVER_URL: "https://mcp.example.com/gitlab"
    });

    expect(isRequestHostAllowed("mcp.example.com:443", policy)).toBe(true);
    expect(isRequestOriginAllowed("https://mcp.example.com", policy)).toBe(true);
    expect(isRequestHostAllowed("attacker.example.com", policy)).toBe(false);
  });

  it("allows requests without Origin for non-browser clients", () => {
    const policy = buildHttpRequestPolicy({ HTTP_HOST: "127.0.0.1", HTTP_PORT: 3333 });
    expect(isRequestOriginAllowed(undefined, policy)).toBe(true);
  });

  it.each([
    "http://localhost:5173",
    "https://localhost:8443",
    "http://127.0.0.1:49152",
    "https://[::1]:9443"
  ])("allows loopback Origin %s on a mapped port", (origin) => {
    const policy = buildHttpRequestPolicy({ HTTP_HOST: "127.0.0.1", HTTP_PORT: 3333 });
    expect(isRequestOriginAllowed(origin, policy)).toBe(true);
  });

  it("keeps non-loopback Origins on an exact allowlist", () => {
    const policy = buildHttpRequestPolicy({
      HTTP_HOST: "0.0.0.0",
      HTTP_PORT: 3333,
      MCP_ALLOWED_HOSTS: ["mcp.example.com"],
      MCP_ALLOWED_ORIGINS: ["https://mcp.example.com:8443"]
    });

    expect(isRequestOriginAllowed("https://mcp.example.com:8443", policy)).toBe(true);
    expect(isRequestOriginAllowed("https://mcp.example.com:9443", policy)).toBe(false);
    expect(isRequestOriginAllowed("https://localhost.example.com:8443", policy)).toBe(false);
    expect(isRequestOriginAllowed("http://127.0.0.2:3333", policy)).toBe(false);
  });

  it.each(["*", "https://user@example.com", "example.com/path"])(
    "rejects unsafe allowed Host entry %s",
    (entry) => {
      expect(() =>
        buildHttpRequestPolicy({
          HTTP_HOST: "0.0.0.0",
          HTTP_PORT: 3333,
          MCP_ALLOWED_HOSTS: [entry]
        })
      ).toThrow("MCP_ALLOWED_HOSTS");
    }
  );

  it.each(["null", "file:///tmp/test", "https://example.com/path"])(
    "rejects unsafe allowed Origin entry %s",
    (entry) => {
      expect(() =>
        buildHttpRequestPolicy({
          HTTP_HOST: "127.0.0.1",
          HTTP_PORT: 3333,
          MCP_ALLOWED_ORIGINS: [entry]
        })
      ).toThrow("MCP_ALLOWED_ORIGINS");
    }
  );
});
