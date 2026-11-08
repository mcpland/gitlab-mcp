import { z } from "zod";

import type { ToolCapability } from "../lib/tool-capabilities.js";
import { nullableOptional } from "../lib/tool-schema.js";
import type { AppContext } from "../types/context.js";
import {
  getOptionalRecord,
  getString,
  jsonBody,
  readCapabilities,
  type GitLabToolDefinitionInput
} from "./shared.js";

export const API_REQUEST_TOOL_NAME = "gitlab_api_request";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type ApiMethod = (typeof METHODS)[number];

const METHOD_CAPABILITY: Readonly<Record<ApiMethod, ToolCapability>> = {
  GET: "read",
  POST: "write",
  PUT: "write",
  PATCH: "write",
  DELETE: "delete"
};

/**
 * Endpoints whose responses or effects are credentials or secrets. Typed
 * tools gate these families separately (CI/CD variable opt-ins, trigger
 * token redaction, ...), and the raw tool must not become a way around those
 * gates, so they are refused here regardless of method.
 */
const CREDENTIAL_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)variables(?:\/|$)/u,
  /(?:^|\/)triggers(?:\/|$)/u,
  /(?:^|\/)(?:personal_|project_|group_)?access_tokens(?:\/|$)/u,
  /(?:^|\/)deploy_tokens(?:\/|$)/u,
  /(?:^|\/)deploy_keys(?:\/|$)/u,
  /(?:^|\/)keys(?:\/|$)/u,
  /(?:^|\/)gpg_keys(?:\/|$)/u,
  /(?:^|\/)runners(?:\/|$)/u,
  /(?:^|\/)hooks(?:\/|$)/u,
  /(?:^|\/)secure_files(?:\/|$)/u,
  /(?:^|\/)application(?:\/|$)/u,
  /(?:^|\/)applications(?:\/|$)/u,
  /(?:^|\/)impersonation_tokens(?:\/|$)/u,
  /(?:^|\/)token(?:\/|$)/u,
  /^\/?graphql(?:\/|$)/u
];

export const apiRequestToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: API_REQUEST_TOOL_NAME,
    title: "GitLab API Request",
    description:
      "Send one GitLab REST request under /api/v4 for endpoints no typed tool covers. path is relative to /api/v4 (for example /projects/42/repository/contributors). The method must be allowed by the permission mode (readonly: GET; modify: no DELETE). Credential and webhook endpoints (variables, tokens, keys, runners, triggers, hooks) and /graphql are refused. Prefer typed tools: this one bypasses their per-family safeguards.",
    capabilities: readCapabilities,
    requiresExplicitEnable: "rawApi",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      method: z.enum(METHODS),
      path: z.string().min(2).max(2048),
      query: nullableOptional(
        z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
        )
      ),
      body: nullableOptional(z.record(z.string(), z.unknown()))
    },
    handler: async (args, context) => {
      const method = getString(args, "method") as ApiMethod;
      assertMethodAllowed(context, method);
      const path = normalizeApiPath(getString(args, "path"));
      const body = getOptionalRecord(args, "body");
      if (body && (method === "GET" || method === "DELETE")) {
        throw new Error(`${method} requests cannot carry a body; use query instead`);
      }

      const options = {
        ...(body ? jsonBody(body) : {}),
        query: toApiQuery(getOptionalRecord(args, "query"))
      };
      switch (method) {
        case "GET":
          return context.gitlab.get(path, options);
        case "POST":
          return context.gitlab.post(path, options);
        case "PUT":
          return context.gitlab.put(path, options);
        case "PATCH":
          return context.gitlab.patch(path, options);
        case "DELETE":
          return context.gitlab.delete(path, options);
      }
    }
  }
];

function assertMethodAllowed(context: AppContext, method: ApiMethod): void {
  context.policy.assertCanExecute({
    name: API_REQUEST_TOOL_NAME,
    capabilities: [METHOD_CAPABILITY[method]]
  });
}

/**
 * Accept only a relative API path: no scheme, host, query, fragment, empty
 * segments, or dot segments (raw or percent-encoded), and nothing that
 * reaches a credential endpoint.
 */
export function normalizeApiPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const path = trimmed.replace(/^\/api\/v4(?=\/)/u, "");
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("path must be relative to /api/v4 and start with '/'");
  }
  if (/[?#\\\s]/u.test(path) || CONTROL_CHARACTERS.test(path)) {
    throw new Error(
      "path must not contain a query, fragment, backslash, whitespace, or control characters; use query for parameters"
    );
  }

  const segments = path.slice(1).split("/");
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(decodeURIComponent(segment));
    } catch {
      throw new Error("path contains an invalid percent-encoding");
    }
    if (segment.length === 0 || decoded === "." || decoded === ".." || decoded.includes("/..")) {
      throw new Error("path must not contain empty, '.', or '..' segments");
    }
  }

  const lowered = segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    })
    .join("/");
  if (CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(lowered))) {
    throw new Error(
      "This endpoint handles credentials, webhooks, or GraphQL and is not available through gitlab_api_request; use the dedicated typed tools"
    );
  }

  return path;
}

function toApiQuery(
  query: Record<string, unknown> | undefined
): Record<string, string | number | boolean | readonly (string | number)[]> {
  const output: Record<string, string | number | boolean | readonly (string | number)[]> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      Array.isArray(value)
    ) {
      output[key] = value as string | number | boolean | readonly (string | number)[];
    }
  }
  return output;
}
