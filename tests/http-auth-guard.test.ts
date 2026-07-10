import { describe, expect, it } from "vitest";

import { assertSafeHttpAuthConfig } from "../src/lib/http-auth-guard.js";

describe("assertSafeHttpAuthConfig", () => {
  it("allows static token usage on local HTTP bind hosts", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(() =>
        assertSafeHttpAuthConfig({
          HTTP_HOST: host,
          GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-test",
          REMOTE_AUTHORIZATION: false
        })
      ).not.toThrow();
    }
  });

  it("allows non-local bind hosts when remote authorization is enabled", () => {
    expect(() =>
      assertSafeHttpAuthConfig({
        HTTP_HOST: "0.0.0.0",
        GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-test",
        REMOTE_AUTHORIZATION: true
      })
    ).not.toThrow();
  });

  it("allows non-local bind hosts without a server-side credential", () => {
    expect(() =>
      assertSafeHttpAuthConfig({
        HTTP_HOST: "0.0.0.0",
        REMOTE_AUTHORIZATION: false
      })
    ).not.toThrow();
  });

  it("rejects static PAT usage on non-local HTTP bind hosts", () => {
    expect(() =>
      assertSafeHttpAuthConfig({
        HTTP_HOST: "0.0.0.0",
        GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-test",
        REMOTE_AUTHORIZATION: false
      })
    ).toThrow("Refusing to start HTTP server with server-side GitLab credentials");
  });

  it("rejects static job token usage on non-local HTTP bind hosts", () => {
    expect(() =>
      assertSafeHttpAuthConfig({
        HTTP_HOST: "0.0.0.0",
        GITLAB_JOB_TOKEN: "job-token-test",
        REMOTE_AUTHORIZATION: false
      })
    ).toThrow("Refusing to start HTTP server with server-side GitLab credentials");
  });

  it.each([
    { GITLAB_USE_OAUTH: true },
    { GITLAB_TOKEN_SCRIPT: "get-token" },
    { GITLAB_TOKEN_FILE: "/run/secrets/gitlab" },
    { GITLAB_AUTH_COOKIE_PATH: "/run/secrets/cookies" }
  ])("rejects non-local server-side credential source %# without inbound auth", (credential) => {
    expect(() =>
      assertSafeHttpAuthConfig({
        HTTP_HOST: "0.0.0.0",
        REMOTE_AUTHORIZATION: false,
        ...credential
      })
    ).toThrow("Refusing to start HTTP server with server-side GitLab credentials");
  });

  it("allows independent MCP bearer auth to protect a non-local server credential", () => {
    expect(() =>
      assertSafeHttpAuthConfig({
        HTTP_HOST: "0.0.0.0",
        GITLAB_TOKEN_FILE: "/run/secrets/gitlab",
        REMOTE_AUTHORIZATION: false,
        MCP_HTTP_AUTH_TOKEN: "m".repeat(32)
      })
    ).not.toThrow();
  });
});
