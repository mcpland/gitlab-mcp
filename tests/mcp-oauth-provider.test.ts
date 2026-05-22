import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitLabMcpOAuthProvider } from "../src/lib/mcp-oauth-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createGitLabMcpOAuthProvider", () => {
  it("returns dynamically registered clients from the local cache", async () => {
    const redirectUris = ["https://mcp-client.example.com/callback"];
    const registeredClient = {
      client_id: "gitlab-client-1",
      client_id_issued_at: 1_765_843_200,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none"
    };
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(registeredClient), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createGitLabMcpOAuthProvider("https://gitlab.example.com/api/v4");
    const registerClient = provider.clientsStore.registerClient;

    expect(registerClient).toBeDefined();
    await registerClient?.({
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none"
    });

    await expect(provider.clientsStore.getClient("gitlab-client-1")).resolves.toMatchObject({
      client_id: "gitlab-client-1",
      redirect_uris: redirectUris
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gitlab.example.com/oauth/register",
      expect.objectContaining({ method: "POST" })
    );
  });
});
