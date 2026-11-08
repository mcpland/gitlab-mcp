import { z } from "zod";

import type { GitLabRequestOptions } from "../lib/gitlab-client.js";
import {
  encodeGitLabGroupId,
  encodeGitLabPathSegment,
  encodeGitLabProjectId,
  isGitLabProjectIdentityAllowed
} from "../lib/gitlab-path.js";
import type { ToolCapability } from "../lib/tool-capabilities.js";
import { nullableOptional, optionalBooleanLikeSchema } from "../lib/tool-schema.js";
import type { AppContext } from "../types/context.js";

/*
 * Shared building blocks for GitLab tool definitions: definition types,
 * capability presets, common argument schemas, and argument readers.
 * Tool families live in their own modules and are assembled by gitlab.ts.
 */

export type ToolArgs = Record<string, unknown>;

export type ToolSchemaShape = Record<string, z.ZodTypeAny>;

export interface GitLabToolDefinition {
  name: string;
  title: string;
  description: string;
  capabilities: ToolCapability[];
  scope: GitLabToolScopeMetadata;
  requiresAuth?: boolean;
  requiresFeature?: "wiki" | "milestone" | "pipeline" | "release";
  requiresExplicitEnable?: "ciVariables" | "dependencyProxy";
  requiresLocalFileTools?: boolean;
  compatibilityAlias?: boolean;
  sensitiveArguments?: readonly string[];
  inputSchema?: ToolSchemaShape;
  handler: (args: ToolArgs, context: AppContext, call?: ToolCallOptions) => Promise<unknown>;
}

export type GitLabToolDefinitionInput = Omit<GitLabToolDefinition, "scope">;

/** Per-call information from the MCP request, such as client cancellation. */
export interface ToolCallOptions {
  signal?: AbortSignal;
}

export type GitLabToolScope = "project" | "group" | "global" | "rawGraphQL";

export interface GitLabToolScopeMetadata {
  kind: GitLabToolScope;
  projectIdArguments?: readonly string[];
  groupIdArguments?: readonly string[];
  projectScopedMode: "allow" | "filter" | "deny";
}

export const readCapabilities: ToolCapability[] = ["read"];
export const writeCapabilities: ToolCapability[] = ["write"];
export const deleteCapabilities: ToolCapability[] = ["delete"];
export const adminCapabilities: ToolCapability[] = ["admin"];
export const adminGraphqlCapabilities: ToolCapability[] = ["admin", "graphql"];
export const adminDeleteCapabilities: ToolCapability[] = ["admin", "delete"];
export const readGraphqlCapabilities: ToolCapability[] = ["read", "graphql"];
export const writeGraphqlCapabilities: ToolCapability[] = ["write", "graphql"];
export const deleteGraphqlCapabilities: ToolCapability[] = ["delete", "graphql"];

export const optionalString = nullableOptional(z.string());
export const optionalNumber = nullableOptional(z.number());
export const optionalPositiveIntegerFromEmptyString = z
  .preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce.number().int().positive().optional()
  )
  .optional();
export const optionalBoolean = optionalBooleanLikeSchema;
export const optionalStringArray = nullableOptional(z.array(z.string()));
export const optionalNumberArray = nullableOptional(z.array(z.number()));
export const optionalStringOrNumber = nullableOptional(z.union([z.string(), z.number()]));
export const optionalStringOrStringArray = nullableOptional(
  z.union([z.string(), z.array(z.string())])
);
export const optionalRecord = nullableOptional(z.record(z.string(), z.unknown()));

export const ciVariableKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_]+$/, "CI/CD variable keys may contain only letters, digits, and '_'");

export const paginationShape = {
  page: optionalNumber,
  per_page: optionalNumber
} satisfies ToolSchemaShape;

export function getString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`'${key}' must be a non-empty string`);
  }

  return value;
}

export function getIdString(args: ToolArgs, key: string): string {
  const value = args[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new Error(`'${key}' must be a non-empty string or number`);
  }

  return String(value);
}

export function getOptionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`'${key}' must be a string`);
  }

  return value;
}

export function getOptionalStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`'${key}' must be string[]`);
  }

  return value;
}

export function getBoolean(args: ToolArgs, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw new Error(`'${key}' must be boolean`);
  }

  return value;
}

export function getNumber(args: ToolArgs, key: string): number {
  const value = args[key];
  const numericValue = typeof value === "string" ? Number(value) : value;
  if (typeof numericValue !== "number" || Number.isNaN(numericValue)) {
    throw new Error(`'${key}' must be number`);
  }

  return numericValue;
}

export function getRequiredStringArray(args: ToolArgs, key: string): string[] {
  const value = getOptionalStringArray(args, key);
  if (!value || value.length === 0) {
    throw new Error(`'${key}' must be a non-empty string array`);
  }
  return value;
}

export function getOptionalBoolean(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`'${key}' must be boolean`);
  }

  return value;
}

export function getOptionalNumber(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`'${key}' must be number`);
  }

  return value;
}

export function getOptionalArray(args: ToolArgs, key: string): unknown[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`'${key}' must be array`);
  }

  return value;
}

export function getOptionalNumberArray(args: ToolArgs, key: string): number[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error(`'${key}' must be number[]`);
  }

  return value;
}

export function getOptionalRecord(
  args: ToolArgs,
  key: string
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`'${key}' must be an object`);
  }

  return value as Record<string, unknown>;
}

export function requireArrayValue<T>(items: T[], index: number, errorMessage: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(errorMessage);
  }

  return value;
}

export function omit(args: ToolArgs, keys: string[]): ToolArgs {
  const result: ToolArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (!keys.includes(key)) {
      result[key] = value;
    }
  }

  return result;
}

export function pickPresentFields(args: ToolArgs, fields: readonly string[]): ToolArgs {
  const result: ToolArgs = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(args, field) && args[field] !== undefined) {
      result[field] = args[field];
    }
  }
  return result;
}

export function toQuery(args: ToolArgs): Record<string, string | number | boolean | undefined> {
  const output: Record<string, string | number | boolean | undefined> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      const items = value.filter((item) => !(typeof item === "string" && item.trim().length === 0));
      if (items.length > 0) {
        output[key] = items.join(",");
      }
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }

  return output;
}

export function toCsvValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string");
    return items.length > 0 ? items.join(",") : undefined;
  }

  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function resolveProjectId(args: ToolArgs, context: AppContext, required: boolean): string {
  const fromArgs = getOptionalString(args, "project_id");
  const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;

  if (allowed.length > 0) {
    if (fromArgs && !isGitLabProjectIdentityAllowed(fromArgs, allowed)) {
      throw new Error(
        `Project '${fromArgs}' is not in GITLAB_ALLOWED_PROJECT_IDS: ${allowed.join(", ")}`
      );
    }

    if (!fromArgs && allowed.length === 1) {
      return requireArrayValue(allowed, 0, "GITLAB_ALLOWED_PROJECT_IDS is empty");
    }

    if (!fromArgs && allowed.length > 1) {
      throw new Error(
        `Multiple allowed projects configured (${allowed.join(", ")}). Please specify project_id.`
      );
    }

    return fromArgs ?? requireArrayValue(allowed, 0, "GITLAB_ALLOWED_PROJECT_IDS is empty");
  }

  if (required && !fromArgs) {
    throw new Error("project_id is required");
  }

  return fromArgs ?? "";
}

export function resolveExplicitProjectId(context: AppContext, projectId: string): string {
  const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;
  if (allowed.length > 0 && !isGitLabProjectIdentityAllowed(projectId, allowed)) {
    throw new Error(
      `Project '${projectId}' is not in GITLAB_ALLOWED_PROJECT_IDS: ${allowed.join(", ")}`
    );
  }
  return projectId;
}

export function resolveOptionalExplicitProjectId(
  context: AppContext,
  projectId: string | undefined
): string | undefined {
  return projectId ? resolveExplicitProjectId(context, projectId) : undefined;
}

export function pickRecordFields(
  record: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(record, field))
      .map((field) => [field, record[field]])
  );
}

/**
 * Build `/projects/:id/<segments>` for the generic client methods. The project
 * identity is canonicalized and every further value is encoded as exactly one
 * path segment, so IDs such as ".." cannot retarget the request.
 */
export function projectApiPath(projectId: string, ...segments: Array<string | number>): string {
  return [
    `/projects/${encodeGitLabProjectId(projectId)}`,
    ...segments.map((segment) => encodeGitLabPathSegment(String(segment)))
  ].join("/");
}

/** Build `/groups/:id/<segments>` with the same encoding rules as projectApiPath. */
export function groupApiPath(groupId: string, ...segments: Array<string | number>): string {
  return [
    `/groups/${encodeGitLabGroupId(groupId)}`,
    ...segments.map((segment) => encodeGitLabPathSegment(String(segment)))
  ].join("/");
}

/** Request options that send `payload` as a JSON body. */
export function jsonBody(payload: unknown): GitLabRequestOptions {
  return {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" }
  };
}
