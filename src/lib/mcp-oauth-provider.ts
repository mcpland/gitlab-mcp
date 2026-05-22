import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { deriveGitLabBaseUrl } from "./oauth.js";

interface GitLabTokenInfo {
  resource_owner_id?: number;
  scopes?: string[];
  expires_in_seconds?: number | null;
  application?: { uid?: string } | null;
}

class CachedGitLabOAuthProvider extends ProxyOAuthServerProvider {
  private readonly registeredClients = new Map<string, OAuthClientInformationFull>();

  override get clientsStore(): OAuthRegisteredClientsStore {
    const store = super.clientsStore;
    const registerClient = store.registerClient;

    return {
      getClient: async (clientId: string) => {
        return this.registeredClients.get(clientId) ?? store.getClient(clientId);
      },
      ...(registerClient
        ? {
            registerClient: async (
              client: Parameters<NonNullable<OAuthRegisteredClientsStore["registerClient"]>>[0]
            ) => {
              const registeredClient = await registerClient(client);
              this.registeredClients.set(registeredClient.client_id, registeredClient);
              return registeredClient;
            }
          }
        : {})
    };
  }
}

export function createGitLabMcpOAuthProvider(apiUrl: string): ProxyOAuthServerProvider {
  const gitlabBaseUrl = deriveGitLabBaseUrl(apiUrl);

  return new CachedGitLabOAuthProvider({
    endpoints: {
      authorizationUrl: `${gitlabBaseUrl}/oauth/authorize`,
      tokenUrl: `${gitlabBaseUrl}/oauth/token`,
      revocationUrl: `${gitlabBaseUrl}/oauth/revoke`,
      registrationUrl: `${gitlabBaseUrl}/oauth/register`
    },
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const response = await fetch(`${gitlabBaseUrl}/oauth/token/info`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new InvalidTokenError("Invalid or expired GitLab OAuth token");
      }

      const info = (await response.json()) as GitLabTokenInfo;
      return {
        token,
        clientId: info.application?.uid ?? "gitlab-oauth",
        scopes: info.scopes ?? [],
        expiresAt:
          typeof info.expires_in_seconds === "number"
            ? Math.floor(Date.now() / 1000) + info.expires_in_seconds
            : undefined
      };
    },
    getClient: async (clientId: string) => {
      return {
        client_id: clientId,
        redirect_uris: [],
        token_endpoint_auth_method: "none" as const
      };
    }
  });
}
