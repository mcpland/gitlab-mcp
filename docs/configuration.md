# Configuration Reference

All configuration is done through environment variables. The server validates all values at startup using [Zod](https://zod.dev/) schemas and will fail fast with descriptive errors if any value is invalid.

You can set variables in a `.env` file (loaded automatically via `dotenv`) or pass them directly as environment variables. To load a different file, use `--env-file`:

```bash
node dist/index.js --env-file .env.local
node dist/http.js --env-file=.env.production
```

## Core Settings

| Variable              | Type                                                                     | Default                | Description                                                                                         |
| --------------------- | ------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `development` \| `test` \| `production`                                  | `development`          | Runtime environment. Affects error detail mode defaults.                                            |
| `LOG_LEVEL`           | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` | `info`                 | Pino log level.                                                                                     |
| `MCP_SERVER_NAME`     | string                                                                   | `gitlab-mcp`           | Server name reported in MCP handshake.                                                              |
| `MCP_SERVER_VERSION`  | string                                                                   | `package.json` version | Server version reported in MCP handshake.                                                           |
| `MCP_HTTP_AUTH_TOKEN` | string (32+ chars)                                                       | —                      | Independent bearer credential protecting `/mcp`, `/sse`, and `/messages` before request processing. |
| `MCP_ALLOWED_HOSTS`   | CSV string                                                               | —                      | Host header hostname allowlist. Loopback names are always allowed; ports are ignored.               |
| `MCP_ALLOWED_ORIGINS` | CSV string                                                               | —                      | Exact browser Origin allowlist (`scheme://host[:port]`). Requests without Origin remain supported.  |

## GitLab API

| Variable                       | Type   | Default                     | Description                                                                                                                                       |
| ------------------------------ | ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_API_URL`               | string | `https://gitlab.com/api/v4` | Base API URL. Supports **comma-separated** URLs for multi-instance rotation. Each URL is automatically normalized to end with `/api/v4`.          |
| `GITLAB_ALLOWED_HOSTS`         | CSV    | —                           | Additional canonical hosts, `host:port` pairs, or API URLs selectable by `X-GitLab-API-URL`.                                                      |
| `GITLAB_POOL_MAX_SIZE`         | number | `100`                       | Maximum number of distinct configured GitLab API `host:port` entries (1–1000).                                                                    |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | string | —                           | Static default token for requests in default mode (`REMOTE_AUTHORIZATION=false`). If omitted, runtime can still resolve OAuth/script/file tokens. |
| `GITLAB_JOB_TOKEN`             | string | —                           | Static CI job token fallback. Used with the `JOB-TOKEN` header only when `GITLAB_PERSONAL_ACCESS_TOKEN` is not configured.                        |

### Multi-Instance Example

```bash
GITLAB_API_URL=https://gitlab.example.com,https://gitlab-mirror.example.com
```

The client will normalize each entry and rotate across them for load distribution.

## Authentication

### Personal Access Token and CI Job Token

| Variable                       | Type   | Default | Description                                                                   |
| ------------------------------ | ------ | ------- | ----------------------------------------------------------------------------- |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | string | —       | Token with `api` scope. Used as the default request token when set.           |
| `GITLAB_JOB_TOKEN`             | string | —       | CI job token. Used as the default `JOB-TOKEN` only when no PAT is configured. |

### OAuth 2.0 PKCE

| Variable                         | Type         | Default                              | Description                                                                                                                              |
| -------------------------------- | ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_USE_OAUTH`               | boolean      | `false`                              | Enable OAuth PKCE flow.                                                                                                                  |
| `GITLAB_OAUTH_CLIENT_ID`         | string       | —                                    | **Required** when OAuth is enabled. Application ID from GitLab OAuth settings.                                                           |
| `GITLAB_OAUTH_CLIENT_SECRET`     | string       | —                                    | Optional. Required only for confidential OAuth applications.                                                                             |
| `GITLAB_OAUTH_GITLAB_URL`        | string       | derived from `GITLAB_API_URL`        | GitLab base URL for OAuth endpoints (e.g. `https://gitlab.com`).                                                                         |
| `GITLAB_OAUTH_REDIRECT_URI`      | string (URL) | `http://127.0.0.1:8765/callback`     | Local callback URL for the OAuth flow.                                                                                                   |
| `GITLAB_OAUTH_SCOPES`            | string       | `api` (`read_api` in read-only mode) | Space or comma-separated OAuth scopes. If omitted, gitlab-mcp defaults to `read_api` when `GITLAB_READ_ONLY_MODE=true`, otherwise `api`. |
| `GITLAB_OAUTH_TOKEN_PATH`        | string       | `~/.gitlab-mcp-oauth-token.json`     | File path for persisting OAuth tokens. Stored with `chmod 600`.                                                                          |
| `GITLAB_OAUTH_AUTO_OPEN_BROWSER` | boolean      | `true`                               | Automatically open the browser for authorization.                                                                                        |

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

| Variable                 | Type    | Default | Description                                                                                                                                       |
| ------------------------ | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REMOTE_AUTHORIZATION`   | boolean | `false` | Require per-request tokens via `Authorization` (Bearer), `Private-Token`, or `Job-Token` headers for HTTP requests. Disables fallback auth chain. |
| `ENABLE_DYNAMIC_API_URL` | boolean | `false` | Require per-request API URL via `X-GitLab-API-URL` header. Requires `REMOTE_AUTHORIZATION=true`.                                                  |

Dynamic API URLs are allowlisted by canonical `host:port`. Hosts from `GITLAB_API_URL` are always registered; `GITLAB_ALLOWED_HOSTS` adds more. The request header selects a registered entry, but its scheme and path are not forwarded: the server uses the canonical configured API URL ending in `/api/v4`. MCP requests, encrypted download tokens, and direct download requests all use the same policy.

## Policy

| Variable                                  | Type    | Default | Description                                                                                                                                                        |
| ----------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GITLAB_READ_ONLY_MODE`                   | boolean | `false` | Disable tools that require `write`, `delete`, or `admin` capabilities.                                                                                             |
| `GITLAB_ALLOWED_PROJECT_IDS`              | string  | —       | Comma-separated project IDs. If set, only these projects can be accessed. Empty = no restriction.                                                                  |
| `GITLAB_ALLOWED_TOOLS`                    | string  | —       | Comma-separated tool allowlist. Accepts names with or without `gitlab_` prefix (e.g. `get_project` or `gitlab_get_project`). Empty = all tools enabled.            |
| `GITLAB_TOOLSETS`                         | string  | —       | Comma-separated domain presets. Empty or `all` exposes the full registry; `core` is a curated compact set. Presets combine as a union before other policy filters. |
| `GITLAB_ENABLE_COMPATIBILITY_ALIASES`     | boolean | `false` | Expose legacy duplicate names for older clients. Canonical tools remain available when aliases are hidden.                                                         |
| `GITLAB_DISABLED_CAPABILITIES`            | string  | —       | Comma-separated capability denylist. Valid values: `read`, `write`, `delete`, `admin`, `graphql`.                                                                  |
| `GITLAB_DENIED_TOOLS_REGEX`               | string  | —       | Regex pattern to deny tools by name (example: `^gitlab_delete_`). Unsafe nested-quantifier, overly long, or invalid patterns fail startup.                         |
| `GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE` | boolean | `false` | Deprecated compatibility setting. Raw GraphQL tools stay disabled whenever `GITLAB_ALLOWED_PROJECT_IDS` is set.                                                    |

### Strict Project Scope

When `GITLAB_ALLOWED_PROJECT_IDS` is non-empty, it is enforced as a strict resource boundary:

- Every explicit `project_id`, `target_project_id`, and `parent_project_id` must be in the allowlist. With one allowed project, an omitted primary `project_id` can be inferred; with multiple allowed projects, callers must select one where the tool requires it.
- `list_projects`, `search_repositories`, and `list_todos` filter out results whose project cannot be proven allowed. Unscoped `search_code` is replaced with one project search per allowed project.
- Project-form webhook operations remain available, but their group form is rejected. Group-wide wiki, search, iteration, and project-list tools are hidden.
- Namespace/user/event-wide operations, unscoped repository creation and forking, and bulk todo mutation are hidden because their affected project cannot be proven before execution. A single todo is verified against the allowlist before it is marked done.
- Raw GraphQL query/mutation executors are always hidden. Project-bound Work Item tools remain available because their source, target, and parent project arguments are validated.

`GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE` is retained so existing deployments still parse, but setting it to `true` does not expose raw GraphQL tools.

## Feature Toggles

| Variable          | Type    | Default | Description                     |
| ----------------- | ------- | ------- | ------------------------------- |
| `USE_GITLAB_WIKI` | boolean | `true`  | Enable wiki-related tools.      |
| `USE_MILESTONE`   | boolean | `true`  | Enable milestone-related tools. |
| `USE_PIPELINE`    | boolean | `true`  | Enable pipeline and job tools.  |
| `USE_RELEASE`     | boolean | `true`  | Enable release-related tools.   |

## Output

| Variable                             | Type                               | Default                                | Description                                                                                                                         |
| ------------------------------------ | ---------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GITLAB_RESPONSE_MODE`               | `json` \| `compact-json` \| `yaml` | `json`                                 | Response serialization format. `compact-json` omits indentation.                                                                    |
| `GITLAB_MAX_RESPONSE_BYTES`          | number                             | `200000`                               | Maximum response size in bytes (1,024–2,000,000). Responses exceeding this limit are truncated with a `[truncated N bytes]` suffix. |
| `GITLAB_MAX_LOCAL_FILE_BYTES`        | number                             | `250000000`                            | Maximum size in bytes for files saved locally by download tools such as job artifacts (1,024–2,000,000,000).                        |
| `GITLAB_HTTP_TIMEOUT_MS`             | number                             | `20000`                                | GitLab API request timeout in milliseconds (1,000–120,000).                                                                         |
| `GITLAB_AUTH_VALIDATION_TIMEOUT_MS`  | number                             | `5000`                                 | Timeout for pre-session upstream token validation (500–30000ms).                                                                    |
| `GITLAB_AUTH_VALIDATION_TTL_SECONDS` | number                             | `30`                                   | Cache TTL for valid and invalid remote-token checks (1–300s). Cache keys are token digests.                                         |
| `GITLAB_ERROR_DETAIL_MODE`           | `safe` \| `full`                   | `safe` in production, `full` otherwise | Controls error response verbosity. `safe` returns only the error message; `full` includes upstream details.                         |

## Network

| Variable                       | Type    | Default          | Description                                                                                                       |
| ------------------------------ | ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `HTTP_PROXY`                   | string  | —                | HTTP proxy URL.                                                                                                   |
| `HTTPS_PROXY`                  | string  | —                | HTTPS proxy URL. Takes precedence over `HTTP_PROXY` for HTTPS requests.                                           |
| `NO_PROXY`                     | string  | —                | Comma-separated host, suffix, wildcard, or `host:port` entries that bypass the configured proxy.                  |
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

When `MCP_HTTP_AUTH_TOKEN` is configured, clients must send
`Authorization: Bearer <MCP_HTTP_AUTH_TOKEN>` to Streamable HTTP and legacy SSE endpoints. The comparison is constant-time. In `REMOTE_AUTHORIZATION=true` mode, send the independent MCP token in `Authorization` and the upstream GitLab credential in `Private-Token` or `Job-Token`.

Host validation is always enabled. `MCP_SERVER_URL` contributes its hostname and origin automatically. A wildcard bind (`HTTP_HOST=0.0.0.0` or `::`) fails startup unless `MCP_SERVER_URL` or `MCP_ALLOWED_HOSTS` supplies at least one public hostname. Browser requests with an `Origin` header must exactly match `MCP_SERVER_URL` or `MCP_ALLOWED_ORIGINS`; non-browser clients may omit Origin.

## Session Management (HTTP Mode)

| Variable                         | Type    | Default | Description                                                                                        |
| -------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------- |
| `SESSION_TIMEOUT_SECONDS`        | number  | `3600`  | Idle session TTL in seconds (1–86400). Sessions are garbage-collected every 30s.                   |
| `MAX_SESSIONS`                   | number  | `1000`  | Maximum concurrent sessions (1–10000). Returns HTTP 503 when exceeded.                             |
| `MAX_REQUESTS_PER_MINUTE`        | number  | `300`   | Per-session rate limit (1–10000). Returns HTTP 429 when exceeded.                                  |
| `MAX_REQUESTS_PER_MINUTE_PER_IP` | number  | `300`   | Pre-session `/mcp` rate limit per client IP (1–10000). Returns HTTP 429 when exceeded.             |
| `MCP_TRUST_PROXY`                | boolean | `false` | Trust one reverse-proxy hop when resolving the client IP. Never enable for direct public exposure. |

## Validation Rules

The server enforces these cross-field constraints at startup:

- `GITLAB_API_URL` must contain at least one valid URL
- `GITLAB_USE_OAUTH=true` requires `GITLAB_OAUTH_CLIENT_ID`
- `ENABLE_DYNAMIC_API_URL=true` requires `REMOTE_AUTHORIZATION=true`
- `SSE=true` is not compatible with `REMOTE_AUTHORIZATION=true`
- wildcard `HTTP_HOST` values (`0.0.0.0` or `::`) require `MCP_SERVER_URL` or `MCP_ALLOWED_HOSTS`
- `HTTP_HOST` values other than `127.0.0.1`, `localhost`, or `::1` cannot use server-side PAT, job-token, OAuth, token-script, token-file, or cookie credentials unless `MCP_HTTP_AUTH_TOKEN`, `REMOTE_AUTHORIZATION`, or `GITLAB_MCP_OAUTH` protects incoming requests
- `NODE_TLS_REJECT_UNAUTHORIZED=0` requires `GITLAB_ALLOW_INSECURE_TLS=true`
