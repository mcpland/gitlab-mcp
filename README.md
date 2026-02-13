# gitlab-mcp

A production-ready [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for GitLab. Provides **80+ tools** that let AI assistants read and manage GitLab projects, merge requests, issues, pipelines, wikis, releases, and more through a unified, policy-controlled interface.

## Highlights

- **Comprehensive GitLab coverage** — projects, merge requests (with code-context analysis), issues, pipelines, wikis, milestones, releases, labels, commits, branches, GraphQL, and file management
- **Multiple transports** — stdio for local CLI usage, Streamable HTTP for remote deployments, optional SSE
- **Flexible authentication** — personal access tokens, OAuth 2.0 PKCE, external token scripts, token files, cookie-based auth, and per-request remote authorization
- **Policy engine** — read-only mode, tool allowlist/denylist, feature toggles, and project-scoped restrictions
- **Enterprise networking** — HTTP/HTTPS proxy, custom CA certificates, Cloudflare bypass, multi-instance API rotation
- **Output control** — JSON, compact JSON, or YAML formatting with configurable response size limits

## Quick Start

### Client configuration examples

Current format references:

- [MCP transports and protocol](https://modelcontextprotocol.io/docs/concepts/transports)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)
- [JetBrains AI Assistant MCP](https://www.jetbrains.com/help/ai-assistant/configure-an-mcp-server.html)

#### Claude Desktop / Claude Code (stdio)

Claude Desktop reads `claude_desktop_config.json`; Claude Code supports project-level `.mcp.json` and `claude mcp add-json`.

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "gitlab-mcp@latest"],
      "env": {
        "GITLAB_API_URL": "https://gitlab.com/api/v4",
        "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Project-local Claude Code config can be added via:

```bash
claude mcp add-json gitlab '{"type":"stdio","command":"npx","args":["-y","gitlab-mcp@latest"],"env":{"GITLAB_API_URL":"https://gitlab.com/api/v4","GITLAB_PERSONAL_ACCESS_TOKEN":"glpat-xxxxxxxxxxxxxxxxxxxx"}}'
```

#### Claude Desktop / Claude Code (remote HTTP)

```json
{
  "mcpServers": {
    "gitlab": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer glpat-xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

If `ENABLE_DYNAMIC_API_URL=true`, add:

```json
{
  "headers": {
    "Authorization": "Bearer glpat-xxxxxxxxxxxxxxxxxxxx",
    "X-GitLab-API-URL": "https://gitlab.example.com/api/v4"
  }
}
```

#### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "gitlab": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/gitlab-mcp/dist/index.js"],
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "gitlab_pat",
      "description": "GitLab Personal Access Token",
      "password": true
    }
  ],
  "servers": {
    "gitlab": {
      "type": "http",
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer ${input:gitlab_pat}"
      }
    }
  }
}
```

GitHub Copilot Chat in VS Code uses the same `.vscode/mcp.json` server format.

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/absolute/path/to/gitlab-mcp/dist/index.js"],
      "env": {
        "GITLAB_API_URL": "https://gitlab.com/api/v4",
        "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

#### GitLab Duo (`~/.gitlab/duo/mcp.json`)

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/absolute/path/to/gitlab-mcp/dist/index.js"],
      "env": {
        "GITLAB_API_URL": "https://gitlab.com/api/v4",
        "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx"
      }
    }
  },
  "approvedTools": ["gitlab_get_project", "gitlab_list_merge_requests"]
}
```

#### JetBrains AI Assistant

JetBrains can import existing MCP JSON (for example Claude Desktop config), or you can add this server manually in MCP settings:

- stdio command: `node /absolute/path/to/gitlab-mcp/dist/index.js`
- env: same variables shown above (`GITLAB_API_URL`, token/auth settings)
- remote URL mode: `http://127.0.0.1:3333/mcp` with required headers

#### Remote auth behavior matrix

| Server Mode                                                 | Required Request Headers                                                        | Token Fallback Chain |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------- |
| `REMOTE_AUTHORIZATION=false`                                | none                                                                            | enabled              |
| `REMOTE_AUTHORIZATION=true`                                 | `Authorization: Bearer <token>` or `Private-Token: <token>`                     | disabled             |
| `REMOTE_AUTHORIZATION=true` + `ENABLE_DYNAMIC_API_URL=true` | `Authorization` or `Private-Token`, and `X-GitLab-API-URL: https://host/api/v4` | disabled             |

#### Docker

```bash
docker compose up --build
```

The HTTP server will be available at `http://127.0.0.1:3333`.

## MCP Server Configuration

### Transport and entrypoint

| Transport           | Entry Point          | Endpoint                     | Best For                             |
| ------------------- | -------------------- | ---------------------------- | ------------------------------------ |
| **stdio**           | `node dist/index.js` | stdin/stdout                 | Local single-user MCP clients        |
| **Streamable HTTP** | `node dist/http.js`  | `POST/GET/DELETE /mcp`       | Remote/shared deployments            |
| **SSE (legacy)**    | `node dist/http.js`  | `GET /sse`, `POST /messages` | Legacy SSE-only clients (`SSE=true`) |
| **Health**          | `node dist/http.js`  | `GET /healthz`               | Liveness/readiness checks            |

`SSE=true` is not compatible with `REMOTE_AUTHORIZATION=true`.

### Server runtime patterns

#### 1) Local default mode (token fallback chain enabled)

```bash
GITLAB_API_URL=https://gitlab.com/api/v4
GITLAB_PERSONAL_ACCESS_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
node dist/http.js
```

When `REMOTE_AUTHORIZATION=false`, the server resolves credentials in this order:
`GITLAB_PERSONAL_ACCESS_TOKEN` -> OAuth PKCE (`GITLAB_USE_OAUTH=true`) -> `GITLAB_TOKEN_SCRIPT` -> `GITLAB_TOKEN_FILE`.

#### 2) Shared remote mode (strict per-request auth)

```bash
REMOTE_AUTHORIZATION=true
HTTP_HOST=0.0.0.0
HTTP_PORT=3333
node dist/http.js
```

Every request must include either `Authorization: Bearer <token>` or `Private-Token: <token>`.

#### 3) Multi-instance remote mode (dynamic API URL per request)

```bash
REMOTE_AUTHORIZATION=true
ENABLE_DYNAMIC_API_URL=true
HTTP_HOST=0.0.0.0
HTTP_PORT=3333
node dist/http.js
```

In this mode each request must include:

- `Authorization` or `Private-Token`
- `X-GitLab-API-URL: https://your-gitlab-instance/api/v4`

## Tool Categories

All tools are prefixed with `gitlab_` and organized into these categories:

| Category            | Examples                                                                  | Count |
| ------------------- | ------------------------------------------------------------------------- | ----- |
| **Projects**        | `get_project`, `list_projects`, `create_repository`, `fork_repository`    | 8     |
| **Repository**      | `get_repository_tree`, `get_file_contents`, `push_files`, `create_branch` | 8     |
| **Merge Requests**  | `list_merge_requests`, `create_merge_request`, `merge_merge_request`      | 12    |
| **MR Code Context** | `get_merge_request_code_context` (advanced code review)                   | 1     |
| **MR Discussions**  | `list_merge_request_discussions`, `create_merge_request_thread`           | 7     |
| **MR Notes**        | `list_merge_request_notes`, `create_merge_request_note`                   | 6     |
| **Draft Notes**     | `list_draft_notes`, `create_draft_note`, `bulk_publish_draft_notes`       | 7     |
| **Issues**          | `list_issues`, `create_issue`, `update_issue`, issue links                | 12    |
| **Pipelines**       | `list_pipelines`, `get_pipeline_job_output`, `create_pipeline`            | 12    |
| **Commits**         | `list_commits`, `get_commit`, `get_commit_diff`                           | 3     |
| **Labels**          | `list_labels`, `create_label`, `update_label`                             | 5     |
| **Milestones**      | `list_milestones`, `create_milestone`, burndown events                    | 9     |
| **Releases**        | `list_releases`, `create_release`, `download_release_asset`               | 7     |
| **Wiki**            | `list_wiki_pages`, `create_wiki_page`, `update_wiki_page`                 | 5     |
| **Uploads**         | `upload_markdown`, `download_attachment`                                  | 2     |
| **GraphQL**         | `execute_graphql_query`, `execute_graphql_mutation`                       | 3     |
| **Users & Groups**  | `get_users`, `list_namespaces`, `list_events`                             | 6     |
| **Health**          | `health_check`                                                            | 1     |

See [docs/tools.md](docs/tools.md) for the complete reference.

## Policy & Security

The policy engine controls which tools are available at registration time:

```bash
# Read-only mode — disables all mutating tools
GITLAB_READ_ONLY_MODE=true

# Only expose specific tools (supports with or without gitlab_ prefix)
GITLAB_ALLOWED_TOOLS=get_project,list_merge_requests,get_merge_request

# Block tools by regex pattern
GITLAB_DENIED_TOOLS_REGEX=^gitlab_(delete|create)_

# Restrict to specific projects
GITLAB_ALLOWED_PROJECT_IDS=123,456,789

# Keep GraphQL tools enabled in project-scoped mode (disabled by default)
GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE=true

# Disable feature groups
USE_PIPELINE=false
USE_GITLAB_WIKI=false
```

## Configuration

All configuration is done through environment variables. Key settings:

| Area            | Variable                                  | Default                     | Description                                                                         |
| --------------- | ----------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| GitLab API      | `GITLAB_API_URL`                          | `https://gitlab.com/api/v4` | Base API URL. Supports comma-separated multi-instance URLs.                         |
| GitLab API      | `GITLAB_PERSONAL_ACCESS_TOKEN`            | —                           | Static default token used when `REMOTE_AUTHORIZATION=false`.                        |
| Remote Auth     | `REMOTE_AUTHORIZATION`                    | `false`                     | Require per-request token headers in HTTP mode (disables fallback token chain).     |
| Remote Auth     | `ENABLE_DYNAMIC_API_URL`                  | `false`                     | Require `X-GitLab-API-URL` per request. Requires `REMOTE_AUTHORIZATION=true`.       |
| HTTP Server     | `HTTP_HOST`                               | `127.0.0.1`                 | HTTP bind host (`0.0.0.0` for external access).                                     |
| HTTP Server     | `HTTP_PORT`                               | `3333`                      | HTTP server port.                                                                   |
| HTTP Server     | `HTTP_JSON_ONLY`                          | `false`                     | Force JSON-only responses (no streaming framing).                                   |
| HTTP Server     | `SSE`                                     | `false`                     | Enable legacy SSE endpoints (`/sse`, `/messages`). Not compatible with remote auth. |
| Sessions        | `SESSION_TIMEOUT_SECONDS`                 | `3600`                      | Idle session timeout in HTTP mode.                                                  |
| Sessions        | `MAX_SESSIONS`                            | `1000`                      | Maximum concurrent sessions (`503` when reached).                                   |
| Sessions        | `MAX_REQUESTS_PER_MINUTE`                 | `300`                       | Per-session rate limit (`429` when exceeded).                                       |
| Policy          | `GITLAB_READ_ONLY_MODE`                   | `false`                     | Disable mutating tools at registration time.                                        |
| Policy          | `GITLAB_ALLOWED_PROJECT_IDS`              | —                           | Restrict access to specific GitLab project IDs.                                     |
| Policy          | `GITLAB_ALLOWED_TOOLS`                    | —                           | Tool allowlist (supports names with or without `gitlab_` prefix).                   |
| Policy          | `GITLAB_DENIED_TOOLS_REGEX`               | —                           | Regex denylist for tool names.                                                      |
| Policy          | `GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE` | `false`                     | Keep GraphQL tools enabled when project scope restriction is active.                |
| Auth Extensions | `GITLAB_USE_OAUTH`                        | `false`                     | Enable OAuth 2.0 PKCE flow.                                                         |
| Auth Extensions | `GITLAB_TOKEN_SCRIPT`                     | —                           | Resolve token from an external script.                                              |
| Auth Extensions | `GITLAB_TOKEN_FILE`                       | —                           | Resolve token from a local file.                                                    |
| Auth Extensions | `GITLAB_AUTH_COOKIE_PATH`                 | —                           | Enable cookie-jar based session auth from Netscape cookie file.                     |
| Output          | `GITLAB_RESPONSE_MODE`                    | `json`                      | Response format: `json`, `compact-json`, `yaml`.                                    |
| Output          | `GITLAB_MAX_RESPONSE_BYTES`               | `200000`                    | Max response payload (1KB–2MB), oversized payloads are truncated safely.            |
| Output          | `GITLAB_HTTP_TIMEOUT_MS`                  | `20000`                     | Upstream GitLab HTTP timeout (1s–120s).                                             |
| Output          | `GITLAB_ERROR_DETAIL_MODE`                | `safe/full`                 | Error verbosity (`safe` by default in production, `full` otherwise).                |
| Network/TLS     | `HTTP_PROXY`, `HTTPS_PROXY`               | —                           | Proxy settings for outbound GitLab requests.                                        |
| Network/TLS     | `GITLAB_CA_CERT_PATH`                     | —                           | Custom CA certificate path (PEM).                                                   |
| Network/TLS     | `GITLAB_CLOUDFLARE_BYPASS`                | `false`                     | Add browser-like headers for Cloudflare-protected instances.                        |
| Network/TLS     | `GITLAB_USER_AGENT`                       | —                           | Custom User-Agent for GitLab requests.                                              |

See [docs/configuration.md](docs/configuration.md) for the complete reference.

## Authentication Methods

Authentication behavior depends on mode:

1. **`REMOTE_AUTHORIZATION=true` (HTTP strong mode)**
   Each request must include `Authorization: Bearer <token>` or `Private-Token: <token>`.
   When `ENABLE_DYNAMIC_API_URL=true`, each request must also include `X-GitLab-API-URL`.
2. **`REMOTE_AUTHORIZATION=false` (default mode)**
   The server resolves credentials in this order:
   `GITLAB_PERSONAL_ACCESS_TOKEN` -> OAuth PKCE (`GITLAB_USE_OAUTH=true`) -> `GITLAB_TOKEN_SCRIPT` -> `GITLAB_TOKEN_FILE`.

Cookie-based auth (`GITLAB_AUTH_COOKIE_PATH`) is applied independently via a cookie jar and can work with or without a token.

See [docs/authentication.md](docs/authentication.md) for setup guides.

## Development

```bash
pnpm dev           # stdio mode with hot-reload
pnpm dev:http      # HTTP mode with hot-reload
pnpm test          # Run tests
pnpm test:watch    # Run tests in watch mode
pnpm lint          # Lint
pnpm typecheck     # Type check
pnpm inspector     # Launch MCP Inspector
```

### Project Structure

See [docs/architecture.md](docs/architecture.md) for detailed design documentation.

## Documentation

- [Configuration Reference](docs/configuration.md) — All environment variables
- [Tools Reference](docs/tools.md) — Complete list of MCP tools
- [Authentication Guide](docs/authentication.md) — Auth methods and setup
- [Deployment Guide](docs/deployment.md) — Docker, production, and multi-instance
- [Architecture](docs/architecture.md) — Internal design and patterns

## Acknowledgements

This repository references and learns from parts of the implementation in [zereight/gitlab-mcp](https://github.com/zereight/gitlab-mcp). Thanks to the maintainers and contributors for their work.

## License

MIT
