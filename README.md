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

### Remote Server Run

```bash
# Development (stdio, with hot-reload)
pnpm dev

# Development (HTTP server, with hot-reload)
pnpm dev:http

# Production
pnpm build
pnpm start        # stdio
pnpm start:http   # HTTP on 127.0.0.1:3333
```

### Docker

```bash
docker compose up --build
```

The HTTP server will be available at `http://127.0.0.1:3333`.

## Client Configuration

### Claude Desktop / Claude Code (stdio)

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "gitlab-mcp@latest"],
      "env": {
        "GITLAB_API_URL": "your_gitlab_url",
        "GITLAB_PERSONAL_ACCESS_TOKEN": "your_token"
      }
    }
  }
}
```

### Remote HTTP Client

```json
{
  "mcpServers": {
    "gitlab": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "your_token"
      }
    }
  }
}
```

## Transport Modes

| Mode                | Endpoint     | Use Case                                      |
| ------------------- | ------------ | --------------------------------------------- |
| **stdio**           | stdin/stdout | Local CLI tools (Claude Desktop, Claude Code) |
| **Streamable HTTP** | `POST /mcp`  | Remote/shared deployments                     |
| **SSE** (optional)  | `GET /sse`   | Legacy SSE clients (`SSE=true`)               |

The HTTP server also exposes `GET /healthz` for liveness checks.

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

| Variable                       | Default                     | Description                                                   |
| ------------------------------ | --------------------------- | ------------------------------------------------------------- |
| `GITLAB_API_URL`               | `https://gitlab.com/api/v4` | GitLab API base URL (supports comma-separated multi-instance) |
| `GITLAB_PERSONAL_ACCESS_TOKEN` | —                           | Personal access token for stdio mode                          |
| `GITLAB_READ_ONLY_MODE`        | `false`                     | Disable all mutating operations                               |
| `GITLAB_RESPONSE_MODE`         | `json`                      | Output format: `json`, `compact-json`, `yaml`                 |
| `GITLAB_MAX_RESPONSE_BYTES`    | `200000`                    | Maximum response size (1KB–2MB)                               |
| `GITLAB_HTTP_TIMEOUT_MS`       | `20000`                     | API request timeout (1–120s)                                  |
| `HTTP_PORT`                    | `3333`                      | HTTP server port                                              |
| `REMOTE_AUTHORIZATION`         | `false`                     | Require per-request auth tokens in HTTP mode                  |

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
