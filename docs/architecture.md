# Architecture

This document describes the internal design of gitlab-mcp, its module relationships, and key design decisions.

## Overview

gitlab-mcp is structured as a layered MCP server with clear separation between transport, tool registration, API client, and cross-cutting concerns (policy, auth, output formatting).

```
┌──────────────────────────────────────────────────────┐
│              Transport Layer                         │
│  index.ts (stdio)  │  http.ts (HTTP/SSE)             │
└─────────┬──────────┴──────────┬──────────────────────┘
          │                     │
          │    ┌────────────────▼────────────────────┐
          │    │  Session Management (HTTP only)     │
          │    │  - Serial request queuing           │
          │    │  - Rate limiting per session        │
          │    │  - TTL-based garbage collection     │
          │    │  - AsyncLocalStorage auth context   │
          │    └────────────────┬────────────────────┘
          │                     │
┌─────────▼─────────────────────▼──────────────────────┐
│                  MCP Server Factory                  │
│                  build-server.ts                     │
│  ┌──────────────────────────────────────────────┐    │
│  │  registerHealthTool()                        │    │
│  │  registerGitLabTools() ──▶ Policy filtering  │    │
│  └──────────────────────────────────────────────┘    │
└───────────────────────┬──────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────┐
│                   AppContext                         │
│  ┌──────────┐ ┌───────────┐ ┌──────────────────┐     │
│  │   env    │ │  logger   │ │  gitlab (Client) │     │
│  │ (AppEnv) │ │  (Pino)   │ │                  │     │
│  └──────────┘ └───────────┘ └──────────────────┘     │
│  ┌──────────────────┐ ┌─────────────────────────┐    │
│  │ policy (Engine)  │ │ formatter (Output)      │    │
│  └──────────────────┘ └─────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

## Module Dependency Graph

```
config/env.ts
  ▲
  │ (imported by all entry points)
  │
  ├── index.ts (stdio)
  │     └── lib/gitlab-client.ts
  │     └── lib/policy.ts
  │     └── lib/output.ts
  │     └── lib/network.ts
  │     └── lib/request-runtime.ts
  │           └── lib/oauth.ts
  │     └── server/build-server.ts
  │           └── tools/gitlab.ts
  │           │     └── tools/mr-code-context.ts
  │           └── tools/health.ts
  │
  └── http.ts (HTTP)
        └── (same dependencies as index.ts)
        └── lib/auth-context.ts (AsyncLocalStorage)
```

## Key Modules

### `config/env.ts` — Configuration

- Parses and validates all environment variables using Zod schemas
- Enforces cross-field constraints (e.g. OAuth requires client ID, dynamic API URL requires remote auth)
- Normalizes API URLs to `/api/v4` suffix
- Exports a typed `env` singleton and `AppEnv` type
- Fails fast at startup with descriptive error messages

### `server/build-server.ts` — Server Factory

- Creates an `McpServer` instance with configured name and version
- Registers the health check tool
- Registers all GitLab tools after policy filtering
- Pure factory function — no side effects

### `tools/gitlab.ts` — Tool Definitions

- Defines 80+ tools as a `GitLabToolDefinition[]` array
- Each definition specifies: `name`, `title`, `description`, `mutating`, optional `requiresFeature`, `inputSchema` (Zod), and `handler`
- Tools are filtered by the policy engine at registration time
- Tool execution wraps results through the output formatter
- Error handling converts `GitLabApiError` to structured MCP error responses

**Tool execution flow:**

```
Raw args ──▶ stripNullsDeep ──▶ handler(args, context) ──▶ formatter.format() ──▶ MCP response
                                       │
                                       └── assertAuthReady()  (check token exists)
                                       └── resolveProjectId() (apply project allowlist)
```

### `tools/mr-code-context.ts` — MR Code Context

A specialized tool for AI-assisted code review:

1. Fetches MR diff files
2. Filters by glob patterns, extensions, or languages
3. Sorts by changed lines, path, or file size
4. Retrieves file content within a character budget
5. Supports three content modes:
   - **patch** — Raw unified diff
   - **surrounding** — Changed lines with N lines of context from the full file
   - **fullfile** — Complete file content
6. Supports `list_only` mode for two-stage retrieval (list first, then fetch selectively)

### `lib/gitlab-client.ts` — GitLab API Client

- Wraps the GitLab REST API v4 with typed methods
- Supports multi-instance URL rotation (round-robin)
- Pre-request hook system (`beforeRequest`) for token/header injection
- Per-session auth via `AsyncLocalStorage` (checked before each request)
- Configurable timeout with `AbortSignal`
- Error wrapping via `GitLabApiError` with status code and details

**Request lifecycle:**

```
Method call ──▶ Build URL ──▶ Set headers ──▶ beforeRequest hook
     │                                              │
     │                          ┌───────────────────┘
     │                          ▼
     │                   Apply session auth (if available)
     │                   Apply token header
     │                   Apply compatibility headers
     │                          │
     └──────────────────────────▼
                          fetch() with timeout
                                │
                          Parse response / throw GitLabApiError
```

### `lib/policy.ts` — Tool Policy Engine

Controls which tools are available:

1. **Read-only mode** — Blocks all tools marked `mutating: true`
2. **Feature toggles** — Blocks tools requiring disabled features (wiki, milestone, pipeline, release)
3. **Allowlist** — If set, only listed tools are available. Tool names are normalized (accepts `get_project` or `gitlab_get_project`)
4. **Deny regex** — Blocks tools matching a regex pattern

Policy is applied in two places:

- **Registration time** — `filterTools()` removes tools from the MCP server entirely
- **Execution time** — `assertCanExecute()` double-checks (defense in depth)

### `lib/auth-context.ts` — Session Auth Context

Uses Node.js `AsyncLocalStorage` to provide per-request authentication context:

```typescript
interface SessionAuth {
  sessionId?: string;
  token?: string;
  apiUrl?: string;
  header?: "authorization" | "private-token";
  updatedAt: number;
}
```

- In HTTP mode, each request runs within `runWithSessionAuth()` which sets the context
- The GitLab client reads `getSessionAuth()` to get per-request credentials
- In stdio mode, session auth is not used (static PAT is the primary method)

### `lib/request-runtime.ts` — Request Preprocessing

Orchestrates authentication and request modifications:

1. **Cookie management** — Loads Netscape cookie files, auto-reloads on changes, creates `fetch-cookie` wrapper
2. **Session warmup** — Sends a warmup request to establish cookie sessions
3. **Token resolution** — When no request/session/PAT token is present, tries OAuth, then token script, then token file
4. **Compatibility headers** — Applies User-Agent, Accept-Language for Cloudflare bypass
5. **Token caching** — Caches resolved tokens with configurable TTL

### `lib/oauth.ts` — OAuth PKCE Manager

Implements the full OAuth 2.0 PKCE flow:

1. Check stored token → use if not expired
2. Try refresh token → persist new token
3. Fall back to interactive flow:
   - Generate PKCE challenge
   - Build authorization URL
   - Start local HTTP callback server
   - Open browser (optional)
   - Wait for callback (3 minute timeout)
   - Exchange code for token
   - Persist token (chmod 600)

### `lib/network.ts` — Network Runtime

Configures global fetch behavior using `undici`:

- Sets up proxy agent (`ProxyAgent`) if `HTTP_PROXY`/`HTTPS_PROXY` is set
- Loads custom CA certificates from `GITLAB_CA_CERT_PATH`
- Controls TLS verification via `rejectUnauthorized`
- Applied globally via `setGlobalDispatcher()`

### `lib/output.ts` — Response Formatting

- Serializes tool output to JSON (pretty), compact JSON, or YAML
- Enforces `GITLAB_MAX_RESPONSE_BYTES` limit
- Truncates oversized responses with a `[truncated N bytes]` marker
- Returns metadata: `truncated` flag and `bytes` count

### `lib/sanitize.ts` — Null Stripping

`stripNullsDeep()` recursively removes `null` values from objects and arrays before passing them to the GitLab API. This prevents sending `null` in JSON payloads where `undefined` (omission) is the correct behavior.

## HTTP Server Session Management

The HTTP server (`http.ts`) implements a sophisticated session management system:

### Streamable HTTP Sessions

```
Client POST /mcp (no session-id)
  └── Create new session
      ├── Create McpServer instance
      ├── Create StreamableHTTPServerTransport
      ├── Add to pending sessions
      ├── Connect server to transport
      ├── On session init → move to active sessions
      └── Return Mcp-Session-Id header

Client POST /mcp (with Mcp-Session-Id)
  └── Look up existing session
      ├── Refresh auth from request headers
      ├── Check rate limit
      ├── Enqueue request (serial per session)
      └── Process within session auth context
```

### Session Lifecycle

1. **Creation** — New session created on first POST without session ID
2. **Active** — Session receives requests, each queued serially
3. **Idle timeout** — Garbage collected after `SESSION_TIMEOUT_SECONDS` of inactivity
4. **Rate limited** — Returns 429 after `MAX_REQUESTS_PER_MINUTE` per session
5. **Capacity** — Returns 503 when `MAX_SESSIONS` is reached
6. **Shutdown** — All sessions closed gracefully on SIGINT/SIGTERM

### SSE Sessions (Legacy)

When `SSE=true`:

- Clients connect via `GET /sse` to establish an SSE stream
- Messages are sent via `POST /messages?sessionId=...`
- Sessions are cleaned up on client disconnect or idle timeout

## Design Patterns

### Dependency Injection via AppContext

All shared services are bundled into an `AppContext` interface:

```typescript
interface AppContext {
  env: AppEnv;
  logger: Logger;
  gitlab: GitLabClient;
  policy: ToolPolicyEngine;
  formatter: OutputFormatter;
}
```

This is created once at startup and passed to tool registration functions. Tools access all services through this context.

### Null Preprocessing in Zod Schemas

Many MCP clients send `null` for optional parameters. The tool schemas use `z.preprocess()` to convert `null` to `undefined`:

```typescript
const optionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional()
);
```

### Backward Compatibility Aliases

Several tools have backward-compatible aliases to support existing integrations:

- `gitlab_mr_discussions` → alias of `gitlab_list_merge_request_discussions`
- `gitlab_get_merge_request_notes` → alias of `gitlab_list_merge_request_notes`
- `gitlab_edit_milestone` → alias of `gitlab_update_milestone`
- `gitlab_execute_graphql` → backward-compatible executor honoring read-only policy

### Structured Content in Responses

Tool responses include both text content (for display) and structured content (for programmatic access):

```typescript
return {
  content: [{ type: "text", text: formatted.text }],
  structuredContent: {
    result: toStructuredContent(result),
    meta: { truncated: formatted.truncated, bytes: formatted.bytes }
  }
};
```
