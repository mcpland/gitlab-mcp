# Deployment Guide

gitlab-mcp can be deployed in several configurations depending on your use case.

## Transport Modes

| Mode                | Entry Point                         | Best For                                              |
| ------------------- | ----------------------------------- | ----------------------------------------------------- |
| **stdio**           | `node dist/index.js`                | Local CLI tools (Claude Desktop, Claude Code, Cursor) |
| **Streamable HTTP** | `node dist/http.js`                 | Remote deployments, multi-user, shared servers        |
| **SSE** (legacy)    | `node dist/http.js` with `SSE=true` | Legacy SSE-only clients                               |

---

## Local / stdio Mode

### Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

### Claude Code

Add to your Claude Code MCP settings:

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

### Cursor / Other MCP Clients

Most MCP clients support stdio transport. Use the same configuration pattern — set the command to `node`, args to the dist entry point, and pass environment variables.

---

## HTTP Server Mode

### Basic Setup

```bash
# Build
pnpm build

# Start HTTP server
HTTP_HOST=127.0.0.1 HTTP_PORT=3333 node dist/http.js
```

When the server keeps a GitLab credential and listens beyond loopback, protect MCP endpoints with an independent, randomly generated secret (at least 32 characters):

```bash
MCP_HTTP_AUTH_TOKEN=<random-secret>
HTTP_HOST=0.0.0.0
MCP_ALLOWED_HOSTS=your-server.example.com
HTTP_PORT=3333
node dist/http.js
```

Clients then send `Authorization: Bearer <random-secret>`. This protection also covers legacy `/sse` and `/messages` endpoints when `SSE=true`.

### With Remote Authorization

For multi-user deployments where each client provides their own GitLab token:

```bash
REMOTE_AUTHORIZATION=true
HTTP_HOST=0.0.0.0
MCP_ALLOWED_HOSTS=your-server.example.com
HTTP_PORT=3333
node dist/http.js
```

`MCP_SERVER_URL=https://your-server.example.com` can be used instead of `MCP_ALLOWED_HOSTS`; it also seeds the browser Origin allowlist. If browser clients run on a different origin, add it explicitly with `MCP_ALLOWED_ORIGINS=https://client.example.com`. Wildcard Host or Origin entries are intentionally unsupported.

### Prometheus Metrics

Metrics are disabled by default. For a remote Prometheus scraper, configure a dedicated bearer independently of MCP OAuth:

```bash
MCP_METRICS_ENABLED=true
MCP_METRICS_AUTH_TOKEN=<random-secret-at-least-32-characters>
```

Scrape `GET /metrics` with `Authorization: Bearer <secret>`. Host validation always applies; an `Origin` header, when present, must match `MCP_ALLOWED_ORIGINS` or `MCP_SERVER_URL`. The endpoint exports normalized HTTP request/status counters, current session gauges, auth/rate-limit rejection counters, and GitLab upstream latency histograms. It never labels metrics with tokens, request URLs, project/group IDs, session IDs, or IP addresses. GitLab latency measures fetch time to response headers.

When exactly one trusted reverse proxy sits in front of the server, set `MCP_TRUST_PROXY=true` so the pre-session IP limiter uses the proxy-provided client address. Leave it `false` when clients can connect directly; otherwise they can spoof `X-Forwarded-For`. `MAX_REQUESTS_PER_MINUTE_PER_IP` controls this outer limiter, while `MAX_REQUESTS_PER_MINUTE` remains the per-session inner limit.

Clients connect with their credentials:

```json
{
  "mcpServers": {
    "gitlab": {
      "url": "http://your-server:3333/mcp",
      "headers": {
        "Authorization": "Bearer glpat-xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Endpoints

| Endpoint    | Method            | Description                            |
| ----------- | ----------------- | -------------------------------------- |
| `/mcp`      | POST, GET, DELETE | Streamable HTTP MCP endpoint           |
| `/healthz`  | GET               | Health check (session count, status)   |
| `/sse`      | GET               | SSE connection (when `SSE=true`)       |
| `/messages` | POST              | SSE message endpoint (when `SSE=true`) |

### Health Check Response

```json
{
  "status": "ok",
  "server": "gitlab-mcp",
  "activeSessions": 3,
  "activeSseSessions": 0,
  "pendingSessions": 0,
  "maxSessions": 1000,
  "remoteAuthorization": true,
  "readOnlyMode": false,
  "sseEnabled": false
}
```

Status is `"degraded"` when session count reaches `MAX_SESSIONS`.

---

## Docker

### Using Docker Compose

1. Create your `.env` file:

```bash
cp .env.example .env
# Edit .env with your settings
```

2. Start the service:

```bash
docker compose up --build -d
```

The HTTP server will be available at `http://127.0.0.1:3333`.

### Using Dockerfile Directly

```bash
# Build
docker build -t gitlab-mcp .

# Run with environment variables
docker run -d \
  --name gitlab-mcp \
  -p 3333:3333 \
  -e GITLAB_API_URL=https://gitlab.com/api/v4 \
  -e GITLAB_PERSONAL_ACCESS_TOKEN=glpat-xxxx \
  -e NODE_ENV=production \
  gitlab-mcp

# Or with .env file
docker run -d \
  --name gitlab-mcp \
  -p 3333:3333 \
  --env-file .env \
  gitlab-mcp
```

### Docker Image Details

The Dockerfile uses a multi-stage build:

1. **deps** — Install all dependencies
2. **build** — Compile TypeScript
3. **runtime** — Production image with only production dependencies

Base image: `node:22-alpine`
Exposed port: `3333`
Entry point: `node dist/http.js`

---

## Production Considerations

### Session Management

The HTTP server manages sessions with the following controls:

| Setting                   | Default | Description                                                            |
| ------------------------- | ------- | ---------------------------------------------------------------------- |
| `SESSION_TIMEOUT_SECONDS` | `3600`  | Idle session timeout. Sessions are garbage-collected every 30 seconds. |
| `MAX_SESSIONS`            | `1000`  | Maximum concurrent sessions. Returns HTTP 503 when exceeded.           |
| `MAX_REQUESTS_PER_MINUTE` | `300`   | Per-session rate limit. Returns HTTP 429 when exceeded.                |

### Request Serialization

Each session queues requests serially to prevent race conditions. Concurrent requests to the same session are processed in order.

### Error Handling

In production, set error detail mode to `safe` to prevent leaking upstream error details:

```bash
NODE_ENV=production
# Or explicitly:
GITLAB_ERROR_DETAIL_MODE=safe
```

### Response Size Limits

Control response sizes to prevent memory issues:

```bash
GITLAB_MAX_RESPONSE_BYTES=200000   # 200KB default, range: 1KB–2MB
```

Responses exceeding this limit are truncated with a `[truncated N bytes]` suffix.

### Logging

The server uses [Pino](https://getpino.io/) for structured JSON logging:

```bash
LOG_LEVEL=info   # Options: fatal, error, warn, info, debug, trace, silent
```

### Permission Modes

For safety in production environments:

```bash
GITLAB_PERMISSION_MODE=readonly
```

`readonly` disables tools that require `write`, `delete`, or `admin` capabilities at registration time. `modify` allows read, write, and admin capabilities while blocking delete-capability tools; `full` is the default and permits all capabilities.

The deprecated `GITLAB_READ_ONLY_MODE=true` switch takes precedence over `GITLAB_PERMISSION_MODE` and forces `readonly` for existing deployments.

To disable only specific capability classes instead of selecting a permission profile:

```bash
GITLAB_DISABLED_CAPABILITIES=delete,graphql
```

### Tool Restrictions

Limit the available tools:

```bash
# Only expose specific tools
GITLAB_ALLOWED_TOOLS=get_project,list_merge_requests,get_merge_request

# Or block tools by pattern
GITLAB_DENIED_TOOLS_REGEX=^gitlab_(delete|create)_

# Restrict to specific projects
GITLAB_ALLOWED_PROJECT_IDS=123,456
```

Unsafe `GITLAB_DENIED_TOOLS_REGEX` patterns are ignored instead of failing startup.

---

## Multi-Instance Deployment

### Multiple GitLab Instances

The server can rotate across multiple GitLab API URLs:

```bash
GITLAB_API_URL=https://gitlab-primary.example.com,https://gitlab-secondary.example.com
```

URLs are normalized to `/api/v4` automatically. The client rotates across them for load distribution.

### Dynamic API URL (Per-Request)

For serving multiple GitLab instances from a single server:

```bash
REMOTE_AUTHORIZATION=true
ENABLE_DYNAMIC_API_URL=true
```

Clients specify the target GitLab instance via header:

```
X-GitLab-API-URL: https://other-gitlab.example.com/api/v4
```

---

## Reverse Proxy Setup

When deploying behind a reverse proxy (nginx, Caddy, etc.):

1. Ensure the proxy passes through `Mcp-Session-Id` headers
2. Configure appropriate timeouts for long-running requests
3. If using SSE, ensure the proxy supports streaming responses

### nginx Example

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:3333;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    proxy_buffering off;
}

location /healthz {
    proxy_pass http://127.0.0.1:3333;
}
```

---

## Network Configuration

### Proxy

```bash
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
```

### Custom CA Certificate

For internal PKI or self-signed certificates:

```bash
GITLAB_CA_CERT_PATH=/etc/ssl/certs/internal-ca.pem
```

### Insecure TLS

Not recommended for production. Requires explicit acknowledgment:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0
GITLAB_ALLOW_INSECURE_TLS=true
```
