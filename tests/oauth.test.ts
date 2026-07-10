import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { deriveGitLabBaseUrl, GitLabOAuthManager } from "../src/lib/oauth.js";

describe("deriveGitLabBaseUrl", () => {
  it("extracts base URL from standard API URL", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com/api/v4")).toBe(
      "https://gitlab.example.com"
    );
  });

  it("extracts base URL from API URL with trailing slash", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com/api/v4/")).toBe(
      "https://gitlab.example.com"
    );
  });

  it("handles subpath GitLab installations", () => {
    expect(deriveGitLabBaseUrl("https://company.com/gitlab/api/v4")).toBe(
      "https://company.com/gitlab"
    );
  });

  it("handles gitlab.com", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.com/api/v4")).toBe("https://gitlab.com");
  });

  it("handles URL without /api/v4 suffix", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com/custom")).toBe(
      "https://gitlab.example.com/custom"
    );
  });

  it("handles URL with port", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com:8443/api/v4")).toBe(
      "https://gitlab.example.com:8443"
    );
  });

  it("handles HTTP URL", () => {
    expect(deriveGitLabBaseUrl("http://localhost:8080/api/v4")).toBe("http://localhost:8080");
  });
});

describe("GitLabOAuthManager token requests", () => {
  it("refuses redirects while sending refresh credentials", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-mcp-oauth-test-"));
    const tokenPath = path.join(directory, "token.json");
    await fs.writeFile(
      tokenPath,
      JSON.stringify({
        access_token: "expired-access-token",
        token_type: "Bearer",
        refresh_token: "refresh-secret",
        expires_in: 1,
        created_at: 0
      })
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        token_type: "Bearer",
        refresh_token: "new-refresh-token",
        expires_in: 3600
      })
    );

    try {
      const manager = new GitLabOAuthManager(
        {
          clientId: "client-id",
          clientSecret: "client-secret",
          gitlabUrl: "https://gitlab.example.com",
          redirectUri: "http://127.0.0.1:8765/callback",
          scopes: ["api"],
          tokenStoragePath: tokenPath,
          autoOpenBrowser: false
        },
        {} as Logger
      );

      await expect(manager.getAccessToken()).resolves.toBe("new-access-token");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [endpoint, init] = fetchSpy.mock.calls[0] as [URL | string, RequestInit];
      expect(String(endpoint)).toBe("https://gitlab.example.com/oauth/token");
      expect(init.redirect).toBe("error");
      const body = new URLSearchParams(String(init.body));
      expect(body.get("refresh_token")).toBe("refresh-secret");
      expect(body.get("client_secret")).toBe("client-secret");
    } finally {
      fetchSpy.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
