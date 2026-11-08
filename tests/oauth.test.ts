import * as fs from "node:fs/promises";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  deriveGitLabBaseUrl,
  GitLabOAuthManager,
  OAuthTokenEndpointError
} from "../src/lib/oauth.js";

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

describe("GitLabOAuthManager refresh failures", () => {
  async function managerWithExpiredToken(redirectUri = "http://127.0.0.1:1/callback") {
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
    const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
    const manager = new GitLabOAuthManager(
      {
        clientId: "client-id",
        gitlabUrl: "https://gitlab.example.com",
        redirectUri,
        scopes: ["api"],
        tokenStoragePath: tokenPath,
        autoOpenBrowser: false
      },
      logger
    );
    return { manager, logger, tokenPath, cleanup: () => fs.rm(directory, { recursive: true }) };
  }

  it("does not start interactive authorization when GitLab is temporarily unavailable", async () => {
    const { manager, tokenPath, cleanup } = await managerWithExpiredToken();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    try {
      const error = await manager.getAccessToken().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OAuthTokenEndpointError);
      expect((error as OAuthTokenEndpointError).status).toBe(502);
      expect((error as Error).message).toBe("OAuth token endpoint failed: 502");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const stored = JSON.parse(await fs.readFile(tokenPath, "utf8")) as { refresh_token: string };
      expect(stored.refresh_token).toBe("refresh-secret");
    } finally {
      fetchSpy.mockRestore();
      await cleanup();
    }
  });

  it("falls back to authorization only for a rejected grant and logs no response text", async () => {
    const { manager, logger, cleanup } = await managerWithExpiredToken(
      "https://127.0.0.1/callback"
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { error: "invalid_grant", error_description: "token refresh-secret was revoked" },
          { status: 400 }
        )
      );
    try {
      // The https redirect URI makes the interactive fallback fail fast instead of listening.
      await expect(manager.getAccessToken()).rejects.toThrow("Only http redirect URI");

      const warn = logger.warn as unknown as { mock: { calls: unknown[][] } };
      expect(warn.mock.calls[0]?.[0]).toEqual({
        status: 400,
        oauthError: "invalid_grant",
        forceRefresh: false
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("refresh-secret");
      expect(new OAuthTokenEndpointError(503, undefined).grantRejected).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      await cleanup();
    }
  });
});

describe("GitLabOAuthManager interactive callback", () => {
  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() =>
          typeof address === "object" && address
            ? resolve(address.port)
            : reject(new Error("no port"))
        );
      });
    });
  }

  async function createManager(redirectUri: string) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-mcp-oauth-test-"));
    const info = vi.fn();
    const manager = new GitLabOAuthManager(
      {
        clientId: "client-id",
        gitlabUrl: "https://gitlab.example.com",
        redirectUri,
        scopes: ["api"],
        tokenStoragePath: path.join(directory, "token.json"),
        autoOpenBrowser: false
      },
      { info, warn: vi.fn() } as unknown as Logger
    );
    return { manager, info, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  }

  it("refuses to listen for the callback on a non-loopback host", async () => {
    const { manager, cleanup } = await createManager("http://0.0.0.0:8765/callback");
    try {
      await expect(manager.getAccessToken()).rejects.toThrow("must use a loopback host");
    } finally {
      await cleanup();
    }
  });

  it("ignores callbacks with the wrong state and completes with the right one", async () => {
    const port = await freePort();
    const { manager, info, cleanup } = await createManager(`http://127.0.0.1:${port}/callback`);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ access_token: "fresh-token", token_type: "Bearer", expires_in: 3600 })
      );
    try {
      const pending = manager.getAccessToken();
      await vi.waitFor(() => expect(info).toHaveBeenCalled());
      const authorizationUrl = new URL(
        (info.mock.calls[0]?.[0] as { authorizationUrl: string }).authorizationUrl
      );
      const state = authorizationUrl.searchParams.get("state")!;
      const callback = `http://127.0.0.1:${port}/callback`;

      const wrongState = await rawGet(`${callback}?code=attacker&state=wrong`);
      expect(wrongState).toBe(400);

      const accepted = await rawGet(`${callback}?code=real-code&state=${state}`);
      expect(accepted).toBe(200);
      await expect(pending).resolves.toBe("fresh-token");
      const body = new URLSearchParams(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
      expect(body.get("code")).toBe("real-code");
    } finally {
      fetchSpy.mockRestore();
      await cleanup();
    }
  });
});

/** GET through node:http so the mocked global fetch is not involved. */
function rawGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    }).on("error", reject);
  });
}
