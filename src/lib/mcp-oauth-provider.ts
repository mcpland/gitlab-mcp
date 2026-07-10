import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import { deriveGitLabBaseUrl } from "./oauth.js";
import { OAuthGroupAuthorizer } from "./oauth-group-authorizer.js";

interface GitLabTokenInfo {
  resource_owner_id?: number;
  scopes?: string[];
  expires_in_seconds?: number | null;
  application?: { uid?: string } | null;
}

export interface GitLabMcpOAuthProviderOptions {
  allowedGroups?: string[];
  groupCacheTtlMs?: number;
  groupCacheMaxEntries?: number;
  timeoutMs?: number;
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

export function createGitLabMcpOAuthProvider(
  apiUrl: string,
  options: GitLabMcpOAuthProviderOptions = {}
): ProxyOAuthServerProvider {
  const gitlabBaseUrl = deriveGitLabBaseUrl(apiUrl);
  const groupAuthorizer = options.allowedGroups?.length
    ? new OAuthGroupAuthorizer({
        apiUrl,
        allowedGroups: options.allowedGroups,
        cacheTtlMs: options.groupCacheTtlMs ?? 60_000,
        cacheMaxEntries: options.groupCacheMaxEntries ?? 1_000,
        timeoutMs: options.timeoutMs ?? 20_000
      })
    : undefined;

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
      if (groupAuthorizer && !(await groupAuthorizer.authorize(token))) {
        throw new InvalidTokenError("OAuth token owner is not in an allowed GitLab group");
      }
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
