import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { getSessionAuth } from "../lib/auth-context.js";
import { GitLabApiError } from "../lib/gitlab-client.js";
import { healthToolAnnotations } from "../lib/tool-annotations.js";
import { optionalBooleanLikeSchema } from "../lib/tool-schema.js";
import { classifyTransportFailure } from "../lib/transport-error.js";
import type { AppContext } from "../types/context.js";

interface GitLabHealth {
  api_url: string;
  reachable: boolean;
  authenticated: boolean;
  user?: { id?: unknown; username?: unknown };
  version?: unknown;
  revision?: unknown;
  warning?: string;
  error?: { kind: string; code?: string | null; message: string; hint?: string };
}

export function registerHealthTool(server: McpServer, context: AppContext): void {
  server.registerTool(
    "health_check",
    {
      title: "Health Check",
      description:
        "Return server liveness, name, and version. Set check_gitlab=true to also verify that GitLab is reachable, that the configured credential authenticates, and which GitLab version answers.",
      inputSchema: {
        check_gitlab: optionalBooleanLikeSchema
      },
      annotations: healthToolAnnotations
    },
    async (args) => {
      const now = new Date().toISOString();
      const structured: Record<string, unknown> = {
        status: "ok",
        timestamp: now,
        server: { name: context.env.MCP_SERVER_NAME, version: context.env.MCP_SERVER_VERSION }
      };

      if (args.check_gitlab === true) {
        const gitlab = await checkGitLab(context);
        structured.gitlab = gitlab;
        structured.status = !gitlab.reachable
          ? "error"
          : gitlab.authenticated && !gitlab.warning
            ? "ok"
            : "degraded";
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              args.check_gitlab === true
                ? JSON.stringify(structured)
                : `${String(structured.status)} (${now})`
          }
        ],
        structuredContent: structured
      };
    }
  );
}

async function checkGitLab(context: AppContext): Promise<GitLabHealth> {
  const session = getSessionAuth();
  const apiUrl = session?.apiUrl ?? context.env.GITLAB_API_URL;
  const health: GitLabHealth = { api_url: apiUrl, reachable: false, authenticated: false };
  const usesJobToken =
    session?.header === "job-token" ||
    (!session?.token &&
      !context.env.GITLAB_PERSONAL_ACCESS_TOKEN &&
      !!context.env.GITLAB_JOB_TOKEN);

  try {
    const user = await context.gitlab.whoami();
    health.reachable = true;
    health.authenticated = true;
    if (typeof user === "object" && user !== null) {
      const record = user as Record<string, unknown>;
      health.user = { id: record.id, username: record.username };
    }
  } catch (error) {
    const transport = classifyTransportFailure(error);
    if (transport) {
      health.error = {
        kind: transport.kind,
        code: transport.code,
        message: transport.message,
        hint: transport.hint
      };
      return health;
    }

    if (!(error instanceof GitLabApiError)) {
      health.error = {
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error)
      };
      return health;
    }

    health.reachable = true;
    if (usesJobToken && (error.status === 401 || error.status === 403)) {
      health.authenticated = await jobTokenAuthenticates(context);
    } else if (error.status === 403 && isInsufficientScope(error.details)) {
      health.authenticated = true;
      health.warning =
        "The credential is valid but cannot read /user (needs read_user or api scope); tools that look up the current user will fail.";
    } else {
      health.error = { kind: "http", code: String(error.status), message: error.message };
    }
  }

  if (health.authenticated) {
    try {
      const version = await context.gitlab.get("/version");
      if (typeof version === "object" && version !== null) {
        const record = version as Record<string, unknown>;
        health.version = record.version;
        health.revision = record.revision;
      }
    } catch {
      // /version needs read_api; its absence does not make GitLab unhealthy.
    }
  }

  return health;
}

async function jobTokenAuthenticates(context: AppContext): Promise<boolean> {
  try {
    await context.gitlab.get("/job");
    return true;
  } catch {
    return false;
  }
}

function isInsufficientScope(details: unknown): boolean {
  if (typeof details !== "object" || details === null) {
    return false;
  }
  const error = (details as Record<string, unknown>).error;
  return error === "insufficient_scope" || error === "insufficient_granular_scope";
}
