# Configuration Reference

All configuration is done through environment variables. The server validates all values at startup using [Zod](https://zod.dev/) schemas and will fail fast with descriptive errors if any value is invalid.

You can set variables in a `.env` file (loaded automatically via `dotenv`) or pass them directly as environment variables.

## Core Settings

| Variable             | Type                                                                     | Default       | Description                                              |
| -------------------- | ------------------------------------------------------------------------ | ------------- | -------------------------------------------------------- |
| `NODE_ENV`           | `development` \| `test` \| `production`                                  | `development` | Runtime environment. Affects error detail mode defaults. |
| `LOG_LEVEL`          | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` | `info`        | Pino log level.                                          |
| `MCP_SERVER_NAME`    | string                                                                   | `gitlab-mcp`  | Server name reported in MCP handshake.                   |
| `MCP_SERVER_VERSION` | string                                                                   | `0.1.0`       | Server version reported in MCP handshake.                |

## GitLab API

| Variable                       | Type   | Default                     | Description                                                                                                                                |
| ------------------------------ | ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITLAB_API_URL`               | string | `https://gitlab.com/api/v4` | Base API URL. Supports **comma-separated** URLs for multi-instance rotation. Each URL is automatically normalized to end with `/api/v4`.   |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | string | —                           | Static default token for requests. Overridden by per-request auth headers. If omitted, runtime can still resolve OAuth/script/file tokens. |

### Multi-Instance Example

```bash
GITLAB_API_URL=https://gitlab.example.com,https://gitlab-mirror.example.com
```

The client will normalize each entry and rotate across them for load distribution.

## Authentication

### Personal Access Token

| Variable                       | Type   | Default | Description                                                         |
| ------------------------------ | ------ | ------- | ------------------------------------------------------------------- |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | string | —       | Token with `api` scope. Used as the default request token when set. |

### OAuth 2.0 PKCE

| Variable                         | Type         | Default                          | Description                                                                    |
| -------------------------------- | ------------ | -------------------------------- | ------------------------------------------------------------------------------ |
| `GITLAB_USE_OAUTH`               | boolean      | `false`                          | Enable OAuth PKCE flow.                                                        |
| `GITLAB_OAUTH_CLIENT_ID`         | string       | —                                | **Required** when OAuth is enabled. Application ID from GitLab OAuth settings. |
| `GITLAB_OAUTH_CLIENT_SECRET`     | string       | —                                | Optional. Required only for confidential OAuth applications.                   |
| `GITLAB_OAUTH_GITLAB_URL`        | string       | derived from `GITLAB_API_URL`    | GitLab base URL for OAuth endpoints (e.g. `https://gitlab.com`).               |
| `GITLAB_OAUTH_REDIRECT_URI`      | string (URL) | `http://127.0.0.1:8765/callback` | Local callback URL for the OAuth flow.                                         |
| `GITLAB_OAUTH_SCOPES`            | string       | `api`                            | Space or comma-separated OAuth scopes.                                         |
| `GITLAB_OAUTH_TOKEN_PATH`        | string       | `~/.gitlab-mcp-oauth-token.json` | File path for persisting OAuth tokens. Stored with `chmod 600`.                |
| `GITLAB_OAUTH_AUTO_OPEN_BROWSER` | boolean      | `true`                           | Automatically open the browser for authorization.                              |

### External Token Script

| Variable                         | Type   | Default | Description                                                                                                                                                                |
| -------------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_TOKEN_SCRIPT`            | string | —       | Shell command to execute for obtaining a token. Must output either a raw token string or JSON (`{"access_token":"..."}`, `{"token":"..."}`, or `{"private_token":"..."}`). |
| `GITLAB_TOKEN_SCRIPT_TIMEOUT_MS` | number | `10000` | Script execution timeout (500ms–120s).                                                                                                                                     |
| `GITLAB_TOKEN_CACHE_SECONDS`     | number | `300`   | How long to cache the resolved token (0–86400s).                                                                                                                           |

### Token File

| Variable                           | Type    | Default | Description                                                                                    |
| ---------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------- |
| `GITLAB_TOKEN_FILE`                | string  | —       | Path to a file containing a token. Supports `~/` prefix.                                       |
| `GITLAB_ALLOW_INSECURE_TOKEN_FILE` | boolean | `false` | Allow token files with group/other read permissions. By default, the file must be `chmod 600`. |

### Cookie-Based Auth

| Variable                    | Type   | Default | Description                                                          |
| --------------------------- | ------ | ------- | -------------------------------------------------------------------- |
| `GITLAB_AUTH_COOKIE_PATH`   | string | —       | Path to a Netscape-format cookie file. Auto-reloads on file changes. |
| `GITLAB_COOKIE_WARMUP_PATH` | string | `/user` | API path used for session warmup when cookies are loaded.            |

### Remote Authorization (HTTP Mode)

| Variable                 | Type    | Default | Description                                                                                                                       |
| ------------------------ | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `REMOTE_AUTHORIZATION`   | boolean | `false` | Accept per-request tokens via `Authorization` (Bearer) or `Private-Token` headers. If absent, normal fallback auth still applies. |
| `ENABLE_DYNAMIC_API_URL` | boolean | `false` | Accept per-request API URL via `X-GitLab-API-URL` header. Requires `REMOTE_AUTHORIZATION=true`.                                   |

## Policy

| Variable                     | Type    | Default | Description                                                                                                                                             |
| ---------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_READ_ONLY_MODE`      | boolean | `false` | Disable all mutating tools (create, update, delete, merge, etc.).                                                                                       |
| `GITLAB_ALLOWED_PROJECT_IDS` | string  | —       | Comma-separated project IDs. If set, only these projects can be accessed. Empty = no restriction.                                                       |
| `GITLAB_ALLOWED_TOOLS`       | string  | —       | Comma-separated tool allowlist. Accepts names with or without `gitlab_` prefix (e.g. `get_project` or `gitlab_get_project`). Empty = all tools enabled. |
| `GITLAB_DENIED_TOOLS_REGEX`  | string  | —       | Regex pattern to deny tools by name (example: `^gitlab_delete_`).                                                                                       |

## Feature Toggles

| Variable          | Type    | Default | Description                     |
| ----------------- | ------- | ------- | ------------------------------- |
| `USE_GITLAB_WIKI` | boolean | `true`  | Enable wiki-related tools.      |
| `USE_MILESTONE`   | boolean | `true`  | Enable milestone-related tools. |
| `USE_PIPELINE`    | boolean | `true`  | Enable pipeline and job tools.  |
| `USE_RELEASE`     | boolean | `true`  | Enable release-related tools.   |

## Output

| Variable                    | Type                               | Default                                | Description                                                                                                                         |
| --------------------------- | ---------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_RESPONSE_MODE`      | `json` \| `compact-json` \| `yaml` | `json`                                 | Response serialization format. `compact-json` omits indentation.                                                                    |
| `GITLAB_MAX_RESPONSE_BYTES` | number                             | `200000`                               | Maximum response size in bytes (1,024–2,000,000). Responses exceeding this limit are truncated with a `[truncated N bytes]` suffix. |
| `GITLAB_HTTP_TIMEOUT_MS`    | number                             | `20000`                                | GitLab API request timeout in milliseconds (1,000–120,000).                                                                         |
| `GITLAB_ERROR_DETAIL_MODE`  | `safe` \| `full`                   | `safe` in production, `full` otherwise | Controls error response verbosity. `safe` returns only the error message; `full` includes upstream details.                         |

## Network

| Variable                       | Type    | Default          | Description                                                                                                       |
| ------------------------------ | ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `HTTP_PROXY`                   | string  | —                | HTTP proxy URL.                                                                                                   |
| `HTTPS_PROXY`                  | string  | —                | HTTPS proxy URL. Takes precedence over `HTTP_PROXY` for HTTPS requests.                                           |
| `GITLAB_CA_CERT_PATH`          | string  | —                | Path to a custom CA certificate file (PEM format).                                                                |
| `NODE_TLS_REJECT_UNAUTHORIZED` | string  | —                | Set to `0` to disable TLS verification. **Requires** `GITLAB_ALLOW_INSECURE_TLS=true` as explicit acknowledgment. |
| `GITLAB_ALLOW_INSECURE_TLS`    | boolean | `false`          | Acknowledge insecure TLS. Required when `NODE_TLS_REJECT_UNAUTHORIZED=0`.                                         |
| `GITLAB_CLOUDFLARE_BYPASS`     | boolean | `false`          | Add browser-like headers (User-Agent, Accept-Language, Cache-Control) to bypass Cloudflare protection.            |
| `GITLAB_USER_AGENT`            | string  | —                | Custom User-Agent header. If not set and `GITLAB_CLOUDFLARE_BYPASS` is enabled, a Chrome-like UA is used.         |
| `GITLAB_ACCEPT_LANGUAGE`       | string  | `en-US,en;q=0.9` | Accept-Language header (used with Cloudflare bypass).                                                             |

## HTTP Server

These settings apply only to the HTTP transport (`dist/http.js`).

| Variable         | Type    | Default     | Description                                                                                                  |
| ---------------- | ------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `HTTP_HOST`      | string  | `127.0.0.1` | Bind address. Use `0.0.0.0` to listen on all interfaces.                                                     |
| `HTTP_PORT`      | number  | `3333`      | Listen port (1–65535).                                                                                       |
| `HTTP_JSON_ONLY` | boolean | `false`     | Force JSON-only responses (disable streaming).                                                               |
| `SSE`            | boolean | `false`     | Enable legacy SSE transport (`GET /sse`, `POST /messages`). Cannot be used with `REMOTE_AUTHORIZATION=true`. |

## Session Management (HTTP Mode)

| Variable                  | Type   | Default | Description                                                                      |
| ------------------------- | ------ | ------- | -------------------------------------------------------------------------------- |
| `SESSION_TIMEOUT_SECONDS` | number | `3600`  | Idle session TTL in seconds (1–86400). Sessions are garbage-collected every 30s. |
| `MAX_SESSIONS`            | number | `1000`  | Maximum concurrent sessions (1–10000). Returns HTTP 503 when exceeded.           |
| `MAX_REQUESTS_PER_MINUTE` | number | `300`   | Per-session rate limit (1–10000). Returns HTTP 429 when exceeded.                |

## Validation Rules

The server enforces these cross-field constraints at startup:

- `GITLAB_API_URL` must contain at least one valid URL
- `GITLAB_USE_OAUTH=true` requires `GITLAB_OAUTH_CLIENT_ID`
- `ENABLE_DYNAMIC_API_URL=true` requires `REMOTE_AUTHORIZATION=true`
- `SSE=true` is not compatible with `REMOTE_AUTHORIZATION=true`
- `NODE_TLS_REJECT_UNAUTHORIZED=0` requires `GITLAB_ALLOW_INSECURE_TLS=true`
