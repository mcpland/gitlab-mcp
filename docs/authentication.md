# Authentication Guide

gitlab-mcp supports multiple authentication methods with automatic fallback. The server resolves tokens in a priority chain — the first method that returns a valid token wins.

## Token Resolution Order

```
Per-request auth (HTTP mode)
  └─> OAuth 2.0 PKCE
      └─> External token script
          └─> Token file
              └─> Cookie-based auth
                  └─> Static PAT (GITLAB_PERSONAL_ACCESS_TOKEN)
```

---

## 1. Personal Access Token (PAT)

The simplest method. Create a token at **GitLab > Settings > Access Tokens** with the `api` scope.

```bash
GITLAB_PERSONAL_ACCESS_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
```

This token is used as the final fallback in all modes. In stdio mode, it is typically the primary auth method.

---

## 2. OAuth 2.0 PKCE

Browser-based OAuth flow for interactive use. The server launches a local callback server and opens the browser for authorization.

### Setup

1. Register an OAuth application in GitLab (**Settings > Applications** or admin area):
   - **Redirect URI:** `http://127.0.0.1:8765/callback`
   - **Scopes:** `api`
   - **Confidential:** No (for PKCE public clients)
   - Note the **Application ID**

2. Configure environment variables:

```bash
GITLAB_USE_OAUTH=true
GITLAB_OAUTH_CLIENT_ID=your-application-id
GITLAB_OAUTH_REDIRECT_URI=http://127.0.0.1:8765/callback
GITLAB_OAUTH_SCOPES=api
```

### Optional Settings

```bash
# For confidential applications
GITLAB_OAUTH_CLIENT_SECRET=your-client-secret

# Custom GitLab URL (derived from GITLAB_API_URL if not set)
GITLAB_OAUTH_GITLAB_URL=https://gitlab.example.com

# Token storage location (default: ~/.gitlab-mcp-oauth-token.json)
GITLAB_OAUTH_TOKEN_PATH=~/.gitlab-mcp-oauth-token.json

# Disable auto-opening the browser
GITLAB_OAUTH_AUTO_OPEN_BROWSER=false
```

### How It Works

1. On first request, the server checks for a stored token at `GITLAB_OAUTH_TOKEN_PATH`
2. If no valid token exists, it generates a PKCE challenge and opens the browser
3. The user authorizes the application in GitLab
4. GitLab redirects back to the local callback server with an authorization code
5. The server exchanges the code for an access token (with PKCE verifier)
6. The token is persisted to disk (chmod 600) for future sessions
7. On subsequent requests, the stored token is reused until it expires
8. Expired tokens are automatically refreshed using the refresh token

### Notes

- The callback server listens for up to 3 minutes before timing out
- Token files are stored with `0600` permissions
- If refresh fails, the server falls back to interactive authorization

---

## 3. External Token Script

Execute a shell command to obtain a token dynamically. Useful for integration with secret managers, vault systems, or custom token providers.

```bash
GITLAB_TOKEN_SCRIPT=/path/to/get-token.sh
GITLAB_TOKEN_SCRIPT_TIMEOUT_MS=10000   # 500ms–120s (default: 10s)
GITLAB_TOKEN_CACHE_SECONDS=300         # 0–86400s (default: 5min)
```

### Script Output Format

The script must output one of:

1. **Raw token string** (plain text on stdout):

   ```
   glpat-xxxxxxxxxxxxxxxxxxxx
   ```

2. **JSON object** with any of these keys:
   ```json
   { "access_token": "glpat-xxxxxxxxxxxxxxxxxxxx" }
   ```
   ```json
   { "token": "glpat-xxxxxxxxxxxxxxxxxxxx" }
   ```
   ```json
   { "private_token": "glpat-xxxxxxxxxxxxxxxxxxxx" }
   ```

### Example Script

```bash
#!/usr/bin/env bash
set -euo pipefail

# Example: read from environment or secret manager
if [[ -n "${GITLAB_OAUTH_ACCESS_TOKEN:-}" ]]; then
  printf '{"access_token":"%s"}\n' "${GITLAB_OAUTH_ACCESS_TOKEN}"
  exit 0
fi

echo "Token not available" >&2
exit 1
```

The resolved token is cached for `GITLAB_TOKEN_CACHE_SECONDS` to avoid repeated script executions.

---

## 4. Token File

Read a token from a file on disk. The file should contain a raw token string or JSON (same format as the token script output).

```bash
GITLAB_TOKEN_FILE=~/.gitlab-token
```

### Security

By default, the server enforces strict file permissions — the token file must be readable only by the owner (`chmod 600`). If the file has group or other permissions, the server rejects it.

To override this check:

```bash
GITLAB_ALLOW_INSECURE_TOKEN_FILE=true
```

The token is cached for `GITLAB_TOKEN_CACHE_SECONDS` (default: 300s).

---

## 5. Cookie-Based Auth

Use browser cookies from a Netscape-format cookie file. This is useful when working with GitLab instances that use SSO or other browser-based authentication.

```bash
GITLAB_AUTH_COOKIE_PATH=~/.gitlab-cookies.txt
```

### How It Works

1. The server reads cookies from the file in Netscape cookie format
2. A cookie jar is created and attached to all API requests via `fetch-cookie`
3. Before the first API call to each GitLab instance, a warmup request is sent to establish the session
4. If the cookie file changes on disk, it is automatically reloaded

### Warmup Path

The warmup request hits a lightweight endpoint to establish the session:

```bash
GITLAB_COOKIE_WARMUP_PATH=/user   # default
```

### Cookie File Format

Standard Netscape cookie format (tab-separated):

```
# Netscape HTTP Cookie File
.gitlab.example.com	TRUE	/	TRUE	0	_gitlab_session	abc123...
```

Lines starting with `#HttpOnly_` are parsed as HttpOnly cookies.

---

## 6. Remote Authorization (HTTP Mode)

In HTTP transport mode, the server can accept per-request tokens from the client. This is the recommended approach for shared/multi-user deployments.

```bash
REMOTE_AUTHORIZATION=true
```

### Client Headers

The server accepts tokens via:

- **`Authorization: Bearer <token>`** — Standard bearer token
- **`Private-Token: <token>`** — GitLab private token header

### Dynamic API URL

When serving multiple GitLab instances, enable dynamic API URL per request:

```bash
REMOTE_AUTHORIZATION=true
ENABLE_DYNAMIC_API_URL=true
```

Clients can then send:

```
X-GitLab-API-URL: https://other-gitlab.example.com/api/v4
```

### Authentication Flow (HTTP Mode)

1. Client sends a request with auth headers
2. The server extracts the token and optional API URL from headers
3. Auth context is stored in `AsyncLocalStorage` for the duration of the request
4. All GitLab API calls within that request use the per-session credentials
5. If no per-request token is provided and `REMOTE_AUTHORIZATION` is enabled, the request fails

---

## Cloudflare Bypass

If your GitLab instance is behind Cloudflare, enable browser-like headers:

```bash
GITLAB_CLOUDFLARE_BYPASS=true
```

This adds:

- A Chrome-like `User-Agent` header
- `Accept-Language: en-US,en;q=0.9`
- `Cache-Control: no-cache`
- `Pragma: no-cache`

You can also set a custom User-Agent:

```bash
GITLAB_USER_AGENT="MyApp/1.0"
```

---

## TLS & Proxy Configuration

### Custom CA Certificate

For self-signed or internal CA certificates:

```bash
GITLAB_CA_CERT_PATH=/path/to/ca-bundle.pem
```

### HTTP Proxy

```bash
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
```

### Insecure TLS (Not Recommended)

To disable TLS certificate verification, you must explicitly acknowledge the risk:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0
GITLAB_ALLOW_INSECURE_TLS=true
```

Both settings are required — setting only `NODE_TLS_REJECT_UNAUTHORIZED=0` without the acknowledgment flag will cause a startup error.
