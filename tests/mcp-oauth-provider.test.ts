import { createHash } from "node:crypto";

import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGitLabMcpOAuthProvider,
  type GitLabMcpOAuthProviderOptions
} from "../src/lib/mcp-oauth-provider.js";

const APPLICATION_ID = "pre-registered-gitlab-app";
const CALLBACK_URL = "https://mcp.example.com/oauth/callback";
const STATE_SECRET = Buffer.alloc(32, 7).toString("base64url");
const PREVIOUS_STATE_SECRET = Buffer.alloc(32, 8).toString("base64url");
const CLIENT_REDIRECT_URI = "https://mcp-client.example.com/callback";
const CLIENT_CODE_VERIFIER = "v".repeat(43);
const CLIENT_CODE_CHALLENGE = createHash("sha256").update(CLIENT_CODE_VERIFIER).digest("base64url");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createGitLabMcpOAuthProvider", () => {
  it("registers bounded virtual clients locally without calling GitLab DCR", async () => {
    const fetchMock = vi.fn();
    const provider = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const registered = await registerPublicClient(provider);

    expect(registered.client_id).toMatch(/^v1\.client\./);
    await expect(provider.clientsStore.getClient(registered.client_id)).resolves.toMatchObject({
      client_id: registered.client_id,
      redirect_uris: [CLIENT_REDIRECT_URI],
      token_endpoint_auth_method: "none"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves clients across providers and across state-secret rotation", async () => {
    const oldProvider = createProvider({ stateSecret: PREVIOUS_STATE_SECRET });
    const registered = await registerPublicClient(oldProvider);
    const rotatedProvider = createProvider({
      stateSecret: STATE_SECRET,
      previousStateSecret: PREVIOUS_STATE_SECRET
    });

    await expect(
      rotatedProvider.clientsStore.getClient(registered.client_id)
    ).resolves.toMatchObject({
      redirect_uris: [CLIENT_REDIRECT_URI]
    });

    const tampered = `${registered.client_id.slice(0, -1)}${registered.client_id.endsWith("A") ? "B" : "A"}`;
    await expect(rotatedProvider.clientsStore.getClient(tampered)).resolves.toBeUndefined();
  });

  it("preserves confidential downstream client authentication inside the sealed client ID", async () => {
    const providerA = createProvider();
    const registered = await providerA.clientsStore.registerClient?.({
      redirect_uris: [CLIENT_REDIRECT_URI],
      token_endpoint_auth_method: "client_secret_post",
      client_secret: "downstream-client-secret",
      client_secret_expires_at: 1_900_000_000
    });
    expect(registered?.client_id).toMatch(/^v1\.client\./);

    const providerB = createProvider();
    await expect(providerB.clientsStore.getClient(registered!.client_id)).resolves.toMatchObject({
      token_endpoint_auth_method: "client_secret_post",
      client_secret: "downstream-client-secret",
      client_secret_expires_at: 1_900_000_000
    });
  });

  it("expires stateless client registrations after the configured TTL", async () => {
    let now = 1_800_000_000;
    const provider = createProvider({
      clientTtlSeconds: 600,
      now: () => now
    });
    const registered = await registerPublicClient(provider);
    now += 601;

    await expect(provider.clientsStore.getClient(registered.client_id)).resolves.toBeUndefined();
  });

  it("rejects oversized or unsafe dynamic client metadata", async () => {
    const provider = createProvider();
    const registerClient = provider.clientsStore.registerClient;
    expect(registerClient).toBeDefined();

    await expect(
      registerClient?.({
        redirect_uris: Array.from(
          { length: 6 },
          (_, index) => `https://client.example.com/callback/${String(index)}`
        ),
        token_endpoint_auth_method: "none"
      })
    ).rejects.toThrow("between 1 and 5");
    await expect(
      registerClient?.({
        redirect_uris: ["http://client.example.com/callback"],
        token_endpoint_auth_method: "none"
      })
    ).rejects.toThrow("loopback");
    await expect(
      registerClient?.({
        redirect_uris: ["file:///tmp/oauth-code"],
        token_endpoint_auth_method: "none"
      })
    ).rejects.toThrow("native-app custom scheme");
    await expect(
      registerClient?.({
        redirect_uris: ["mailto:oauth@example.com"],
        token_endpoint_auth_method: "none"
      })
    ).rejects.toThrow("native-app custom scheme");
    await expect(
      registerClient?.({
        redirect_uris: ["com.example.mcp:/oauth/callback"],
        token_endpoint_auth_method: "none"
      })
    ).resolves.toMatchObject({ redirect_uris: ["com.example.mcp:/oauth/callback"] });
    await expect(
      registerClient?.({
        redirect_uris: [CLIENT_REDIRECT_URI],
        token_endpoint_auth_method: "none",
        response_types: []
      })
    ).rejects.toThrow("code response type");
    await expect(
      registerClient?.({
        redirect_uris: [CLIENT_REDIRECT_URI],
        token_endpoint_auth_method: "tls_client_auth"
      })
    ).rejects.toThrow("client_secret_post");
  });

  it("uses the pre-registered app, fixed callback, required scopes, and proxy PKCE", async () => {
    const fetchMock = vi.fn();
    const providerA = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const registered = await registerPublicClient(providerA);
    const providerB = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const client = await providerB.clientsStore.getClient(registered.client_id);
    expect(client).toBeDefined();
    const response = createResponseRecorder();

    await providerB.authorize(
      client!,
      {
        redirectUri: CLIENT_REDIRECT_URI,
        codeChallenge: CLIENT_CODE_CHALLENGE,
        state: "client-state",
        scopes: ["api"]
      },
      response.value
    );

    const location = response.redirectLocation();
    const authorizeUrl = new URL(location);
    expect(authorizeUrl.origin).toBe("https://gitlab.example.com");
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(APPLICATION_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(authorizeUrl.searchParams.get("scope")).toBe("api");
    expect(authorizeUrl.searchParams.get("code_challenge")).not.toBe(CLIENT_CODE_CHALLENGE);
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^v1\.state\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported scopes, foreign resources, and oversized client state", async () => {
    const provider = createProvider();
    const client = await registerPublicClient(provider);
    const response = createResponseRecorder();
    const baseParams = {
      redirectUri: CLIENT_REDIRECT_URI,
      codeChallenge: CLIENT_CODE_CHALLENGE
    };

    await expect(
      provider.authorize(client, { ...baseParams, scopes: ["sudo"] }, response.value)
    ).rejects.toThrow("scope");
    const multiScopeProvider = createProvider({ scopes: ["api", "read_api"] });
    const multiScopeClient = await registerPublicClient(multiScopeProvider);
    await expect(
      multiScopeProvider.authorize(
        multiScopeClient,
        { ...baseParams, scopes: ["read_api"] },
        response.value
      )
    ).rejects.toThrow("every scope");
    await expect(
      provider.authorize(
        client,
        { ...baseParams, resource: new URL("https://other.example.com/") },
        response.value
      )
    ).rejects.toThrow("resource");
    await expect(
      provider.authorize(client, { ...baseParams, state: "x".repeat(513) }, response.value)
    ).rejects.toThrow("state");
  });

  it("completes authorize, callback, and token exchange across independent providers", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void init;
      const url = new URL(String(input));
      if (url.pathname === "/oauth/token") {
        return Response.json({
          access_token: "gitlab-access-token",
          refresh_token: "gitlab-refresh-token",
          token_type: "Bearer",
          expires_in: 7_200,
          scope: "api"
        });
      }
      if (url.pathname === "/oauth/token/info") {
        return validTokenInfo();
      }
      return new Response("not found", { status: 404 });
    });
    const common = {
      fetch: fetchMock as unknown as typeof fetch,
      applicationSecret: "gitlab-application-secret"
    };
    const providerA = createProvider(common);
    const registered = await registerPublicClient(providerA);
    const authorizeResponse = createResponseRecorder();
    await providerA.authorize(
      registered,
      {
        redirectUri: CLIENT_REDIRECT_URI,
        codeChallenge: CLIENT_CODE_CHALLENGE,
        state: "downstream-state",
        scopes: ["api"]
      },
      authorizeResponse.value
    );
    const upstreamState = new URL(authorizeResponse.redirectLocation()).searchParams.get("state");
    expect(upstreamState).toBeTruthy();

    const providerB = createProvider(common);
    const callbackResponse = createResponseRecorder();
    await providerB.handleCallback(
      { query: { code: "single-use-gitlab-code", state: upstreamState } } as unknown as Request,
      callbackResponse.value
    );
    const downstreamRedirect = new URL(callbackResponse.redirectLocation());
    expect(downstreamRedirect.origin).toBe("https://mcp-client.example.com");
    expect(downstreamRedirect.searchParams.get("state")).toBe("downstream-state");
    const proxyCode = downstreamRedirect.searchParams.get("code");
    expect(proxyCode).toMatch(/^v1\.code\./);

    const providerC = createProvider(common);
    const client = await providerC.clientsStore.getClient(registered.client_id);
    const tokens = await providerC.exchangeAuthorizationCode(
      client!,
      proxyCode!,
      CLIENT_CODE_VERIFIER,
      CLIENT_REDIRECT_URI
    );
    expect(tokens.access_token).toBe("gitlab-access-token");
    expect(tokens.refresh_token).toMatch(/^v1\.refresh\./);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/oauth/token")
    );
    const requestInit = tokenCall?.[1];
    const body = new URLSearchParams(String(requestInit?.body));
    expect(body.get("client_id")).toBe(APPLICATION_ID);
    expect(body.get("client_secret")).toBe("gitlab-application-secret");
    expect(body.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(body.get("code")).toBe("single-use-gitlab-code");
    expect(body.get("code_verifier")).not.toBe(CLIENT_CODE_VERIFIER);
  });

  it("binds proxy codes to client, redirect_uri, and downstream PKCE", async () => {
    const fetchMock = vi.fn();
    const common = { fetch: fetchMock as unknown as typeof fetch };
    const provider = createProvider(common);
    const registered = await registerPublicClient(provider);
    const proxyCode = await issueProxyCode(provider, registered.client_id);
    const otherClient = await registerPublicClient(provider, "https://other.example.com/callback");

    await expect(
      provider.exchangeAuthorizationCode(
        otherClient,
        proxyCode,
        CLIENT_CODE_VERIFIER,
        CLIENT_REDIRECT_URI
      )
    ).rejects.toThrow("different client");
    await expect(
      provider.exchangeAuthorizationCode(
        registered,
        proxyCode,
        CLIENT_CODE_VERIFIER,
        "https://mcp-client.example.com/other"
      )
    ).rejects.toThrow("redirect_uri");
    await expect(
      provider.exchangeAuthorizationCode(registered, proxyCode, "x".repeat(43), CLIENT_REDIRECT_URI)
    ).rejects.toThrow("PKCE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relies on GitLab's upstream code consumption to reject proxy-code replay", async () => {
    let tokenExchanges = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/oauth/token/info") {
        return validTokenInfo();
      }
      if (url.pathname === "/oauth/token") {
        tokenExchanges += 1;
        return tokenExchanges === 1
          ? Response.json({ access_token: "token", token_type: "Bearer", expires_in: 7_200 })
          : new Response("used", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const registered = await registerPublicClient(provider);
    const proxyCode = await issueProxyCode(provider, registered.client_id);

    await expect(
      provider.exchangeAuthorizationCode(
        registered,
        proxyCode,
        CLIENT_CODE_VERIFIER,
        CLIENT_REDIRECT_URI
      )
    ).resolves.toMatchObject({ access_token: "token" });
    await expect(
      provider.exchangeAuthorizationCode(
        registered,
        proxyCode,
        CLIENT_CODE_VERIFIER,
        CLIENT_REDIRECT_URI
      )
    ).rejects.toThrow("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("wraps GitLab refresh tokens and binds them to the virtual client", async () => {
    let tokenExchanges = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void init;
      const url = new URL(String(input));
      if (url.pathname === "/oauth/token/info") {
        return validTokenInfo();
      }
      if (url.pathname === "/oauth/token") {
        tokenExchanges += 1;
        return tokenExchanges === 1
          ? Response.json({
              access_token: "initial-access-token",
              refresh_token: "gitlab-refresh-token",
              token_type: "Bearer",
              expires_in: 7_200
            })
          : Response.json({
              access_token: "refreshed-access-token",
              refresh_token: "rotated-gitlab-refresh-token",
              token_type: "Bearer",
              expires_in: 7_200
            });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const client = await registerPublicClient(provider);
    const proxyCode = await issueProxyCode(provider, client.client_id);
    const initialTokens = await provider.exchangeAuthorizationCode(
      client,
      proxyCode,
      CLIENT_CODE_VERIFIER,
      CLIENT_REDIRECT_URI
    );
    const wrappedRefreshToken = initialTokens.refresh_token!;
    const otherClient = await registerPublicClient(provider, "https://other.example.com/callback");

    await expect(provider.exchangeRefreshToken(otherClient, wrappedRefreshToken)).rejects.toThrow(
      "this client"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const tokens = await provider.exchangeRefreshToken(client, wrappedRefreshToken);
    expect(tokens.access_token).toBe("refreshed-access-token");
    expect(tokens.refresh_token).toMatch(/^v1\.refresh\./);
    const tokenCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/oauth/token")
    );
    const body = new URLSearchParams(String(tokenCalls[1]?.[1]?.body));
    expect(body.get("refresh_token")).toBe("gitlab-refresh-token");
  });

  it("does not issue or accept refresh tokens for a client without the refresh grant", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return url.pathname === "/oauth/token"
        ? Response.json({
            access_token: "access-token",
            refresh_token: "gitlab-refresh-token",
            token_type: "Bearer",
            expires_in: 7_200
          })
        : validTokenInfo();
    });
    const provider = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const client = await provider.clientsStore.registerClient?.({
      redirect_uris: [CLIENT_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"]
    });
    const proxyCode = await issueProxyCode(provider, client!.client_id);

    const tokens = await provider.exchangeAuthorizationCode(
      client!,
      proxyCode,
      CLIENT_CODE_VERIFIER,
      CLIENT_REDIRECT_URI
    );
    expect(tokens.access_token).toBe("access-token");
    expect(tokens.refresh_token).toBeUndefined();
    await expect(provider.exchangeRefreshToken(client!, "unusable-refresh-token")).rejects.toThrow(
      "not registered"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still revokes a raw access token when token_type_hint incorrectly says refresh_token", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void input;
      void init;
      return new Response(null, { status: 200 });
    });
    const provider = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const client = await registerPublicClient(provider);

    await provider.revokeToken(client, {
      token: "raw-access-token",
      token_type_hint: "refresh_token"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.get("token")).toBe("raw-access-token");
    expect(body.get("token_type_hint")).toBe("refresh_token");
  });

  it("passes GitLab authorization errors back to the original client", async () => {
    const provider = createProvider();
    const registered = await registerPublicClient(provider);
    const authorizeResponse = createResponseRecorder();
    await provider.authorize(
      registered,
      {
        redirectUri: CLIENT_REDIRECT_URI,
        codeChallenge: CLIENT_CODE_CHALLENGE,
        state: "client-state",
        scopes: ["api"]
      },
      authorizeResponse.value
    );
    const upstreamState = new URL(authorizeResponse.redirectLocation()).searchParams.get("state");
    const callbackResponse = createResponseRecorder();

    await provider.handleCallback(
      {
        query: {
          state: upstreamState,
          error: "access_denied",
          error_description: "User denied access"
        }
      } as unknown as Request,
      callbackResponse.value
    );

    const location = new URL(callbackResponse.redirectLocation());
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toBe("User denied access");
    expect(location.searchParams.get("state")).toBe("client-state");
  });

  it("checks app identity, required scopes, and allowed group membership", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/oauth/token/info") {
        return Response.json({
          resource_owner_id: 42,
          scopes: ["api"],
          expires_in_seconds: 7_200,
          application: { uid: APPLICATION_ID }
        });
      }
      if (url.pathname === "/api/v4/groups") {
        return Response.json([{ full_path: "my-org/engineering" }], {
          headers: { "x-next-page": "" }
        });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = createProvider({
      fetch: fetchMock as unknown as typeof fetch,
      allowedGroups: ["my-org"]
    });

    await expect(provider.verifyAccessToken("oauth-token")).resolves.toMatchObject({
      token: "oauth-token",
      clientId: APPLICATION_ID,
      scopes: ["api"]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects tokens issued to another GitLab application before group lookup", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        scopes: ["api"],
        expires_in_seconds: 7_200,
        application: { uid: "other-app" }
      })
    );
    const provider = createProvider({
      fetch: fetchMock as unknown as typeof fetch,
      allowedGroups: ["my-org"]
    });

    await expect(provider.verifyAccessToken("oauth-token")).rejects.toThrow(
      "not issued for this MCP server"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects tokens missing a configured GitLab scope", async () => {
    const provider = createProvider({
      fetch: vi.fn(async () =>
        Response.json({
          scopes: ["read_user"],
          expires_in_seconds: 7_200,
          application: { uid: APPLICATION_ID }
        })
      ) as unknown as typeof fetch
    });

    await expect(provider.verifyAccessToken("oauth-token")).rejects.toThrow("required scope");
  });

  it.each([
    {
      label: "another application",
      tokenInfo: { scopes: ["api"], application: { uid: "other-app" } }
    },
    {
      label: "missing required scopes",
      tokenInfo: { scopes: ["read_user"], application: { uid: APPLICATION_ID } }
    }
  ])("withholds and revokes a newly issued token for $label", async ({ tokenInfo }) => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/oauth/token") {
        return Response.json({
          access_token: "invalid-issued-token",
          token_type: "Bearer",
          expires_in: 7_200
        });
      }
      if (url.pathname === "/oauth/token/info") {
        return Response.json({ ...tokenInfo, expires_in_seconds: 7_200 });
      }
      if (url.pathname === "/oauth/revoke") {
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = createProvider({ fetch: fetchMock as unknown as typeof fetch });
    const client = await registerPublicClient(provider);
    const proxyCode = await issueProxyCode(provider, client.client_id);

    await expect(
      provider.exchangeAuthorizationCode(
        client,
        proxyCode,
        CLIENT_CODE_VERIFIER,
        CLIENT_REDIRECT_URI
      )
    ).rejects.toThrow("failed validation");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/oauth/revoke"))).toBe(
      true
    );
  });

  it("fails closed when the OAuth token owner is outside allowed groups", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return url.pathname === "/oauth/token/info"
        ? Response.json({
            scopes: ["api"],
            expires_in_seconds: 7_200,
            application: { uid: APPLICATION_ID }
          })
        : Response.json([{ full_path: "other-org" }], { headers: { "x-next-page": "" } });
    });
    const provider = createProvider({
      fetch: fetchMock as unknown as typeof fetch,
      allowedGroups: ["my-org"]
    });

    await expect(provider.verifyAccessToken("oauth-token")).rejects.toThrow("allowed GitLab group");
  });

  it("withholds and revokes newly issued tokens for users outside allowed groups", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void init;
      const url = new URL(String(input));
      if (url.pathname === "/oauth/token") {
        return Response.json({
          access_token: "denied-access-token",
          token_type: "Bearer",
          expires_in: 7_200
        });
      }
      if (url.pathname === "/oauth/token/info") {
        return validTokenInfo();
      }
      if (url.pathname === "/api/v4/groups") {
        return Response.json([{ full_path: "other-org" }], {
          headers: { "x-next-page": "" }
        });
      }
      if (url.pathname === "/oauth/revoke") {
        return new Response(null, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const provider = createProvider({
      fetch: fetchMock as unknown as typeof fetch,
      allowedGroups: ["my-org"]
    });
    const client = await registerPublicClient(provider);
    const proxyCode = await issueProxyCode(provider, client.client_id);

    await expect(
      provider.exchangeAuthorizationCode(
        client,
        proxyCode,
        CLIENT_CODE_VERIFIER,
        CLIENT_REDIRECT_URI
      )
    ).rejects.toThrow("failed validation");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const revokeCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/oauth/revoke")
    );
    expect(String(revokeCall?.[1]?.body)).toContain("token=denied-access-token");
  });
});

function createProvider(overrides: Partial<GitLabMcpOAuthProviderOptions> = {}) {
  return createGitLabMcpOAuthProvider("https://gitlab.example.com/api/v4", {
    applicationId: APPLICATION_ID,
    callbackUrl: CALLBACK_URL,
    stateSecret: STATE_SECRET,
    scopes: ["api"],
    resourceServerUrl: "https://mcp.example.com/",
    resourceName: "Test GitLab MCP",
    ...overrides
  });
}

function validTokenInfo(): globalThis.Response {
  return Response.json({
    scopes: ["api"],
    expires_in_seconds: 7_200,
    application: { uid: APPLICATION_ID }
  });
}

async function registerPublicClient(
  provider: ReturnType<typeof createProvider>,
  redirectUri = CLIENT_REDIRECT_URI
) {
  const registerClient = provider.clientsStore.registerClient;
  if (!registerClient) {
    throw new Error("Provider does not support DCR");
  }
  return registerClient({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Test MCP Client"
  });
}

async function issueProxyCode(
  provider: ReturnType<typeof createProvider>,
  clientId: string
): Promise<string> {
  const client = await provider.clientsStore.getClient(clientId);
  if (!client) {
    throw new Error("Unknown test client");
  }
  const authorizeResponse = createResponseRecorder();
  await provider.authorize(
    client,
    {
      redirectUri: CLIENT_REDIRECT_URI,
      codeChallenge: CLIENT_CODE_CHALLENGE,
      state: "client-state",
      scopes: ["api"]
    },
    authorizeResponse.value
  );
  const state = new URL(authorizeResponse.redirectLocation()).searchParams.get("state");
  const callbackResponse = createResponseRecorder();
  await provider.handleCallback(
    { query: { code: "gitlab-code", state } } as unknown as Request,
    callbackResponse.value
  );
  const code = new URL(callbackResponse.redirectLocation()).searchParams.get("code");
  if (!code) {
    throw new Error("Callback did not issue a proxy code");
  }
  return code;
}

function createResponseRecorder(): {
  value: Response;
  redirectLocation: () => string;
} {
  let location: string | undefined;
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(function status() {
      return response;
    }),
    send: vi.fn(function send() {
      return response;
    }),
    redirect: vi.fn((_status: number, target: string) => {
      location = target;
    })
  };
  return {
    value: response as unknown as Response,
    redirectLocation: () => {
      if (!location) {
        throw new Error("Response did not redirect");
      }
      return location;
    }
  };
}
