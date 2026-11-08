import { z } from "zod";

import { nullableOptional, optionalProjectIdSchema } from "../lib/tool-schema.js";
import type { AppContext } from "../types/context.js";
import {
  executeGraphqlData,
  getOptionalNumber,
  getOptionalString,
  getString,
  isRecord,
  optionalString,
  readGraphqlCapabilities,
  resolveProjectId,
  writeGraphqlCapabilities,
  type GitLabToolDefinitionInput,
  type ToolArgs
} from "./shared.js";

const VULNERABILITY_GID_PREFIX = "gid://gitlab/Vulnerability/";
const PROJECT_GID_PREFIX = "gid://gitlab/Project/";

const VULNERABILITY_FIELDS = `
  id
  title
  description
  state
  severity
  reportType
  detectedAt
  confirmedAt
  resolvedAt
  dismissedAt
  dismissalReason
  webUrl
  scanner { name externalId vendor }
  identifiers { externalType externalId name url }
  links { name url }
  location {
    ... on VulnerabilityLocationSast { file startLine endLine }
    ... on VulnerabilityLocationSecretDetection { file startLine endLine }
    ... on VulnerabilityLocationDependencyScanning {
      file
      dependency { package { name } version }
    }
    ... on VulnerabilityLocationContainerScanning {
      image
      operatingSystem
      dependency { package { name } version }
    }
    ... on VulnerabilityLocationDast { path hostname }
  }
  project { id fullPath }
`;

const stateValues = ["detected", "confirmed", "resolved", "dismissed"] as const;
const severityValues = ["critical", "high", "medium", "low", "info", "unknown"] as const;
const reportTypeValues = [
  "sast",
  "dast",
  "dependency_scanning",
  "container_scanning",
  "secret_detection",
  "coverage_fuzzing",
  "api_fuzzing",
  "cluster_image_scanning",
  "generic"
] as const;

function enumFilter<const T extends readonly [string, ...string[]]>(values: T) {
  return nullableOptional(z.union([z.enum(values), z.array(z.enum(values)).min(1)]));
}

const vulnerabilityIdSchema = z.coerce.string().min(1);
const commentSchema = nullableOptional(z.string().max(10_000));

export const vulnerabilityToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_project_vulnerabilities",
    title: "List Project Vulnerabilities",
    description:
      "List a project's vulnerabilities with severity, state, scanner, identifiers (CVE/CWE), and location. Filter by state, severity, and report_type; page with first and the returned page_info.end_cursor as after. Ultimate.",
    capabilities: readGraphqlCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      state: enumFilter(stateValues),
      severity: enumFilter(severityValues),
      report_type: enumFilter(reportTypeValues),
      first: z.number().int().min(1).max(100).optional(),
      after: optionalString
    },
    handler: async (args, context) => {
      const fullPath = await resolveProjectFullPath(context, resolveProjectId(args, context, true));
      const data = await executeGraphqlData<{
        project?: {
          vulnerabilities?: {
            nodes?: unknown[];
            pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
          };
        } | null;
      }>(
        context,
        `query ProjectVulnerabilities(
          $fullPath: ID!, $state: [VulnerabilityState!], $severity: [VulnerabilitySeverity!],
          $reportType: [VulnerabilityReportType!], $first: Int, $after: String
        ) {
          project(fullPath: $fullPath) {
            vulnerabilities(
              state: $state, severity: $severity, reportType: $reportType, first: $first, after: $after
            ) {
              nodes { ${VULNERABILITY_FIELDS} }
              pageInfo { endCursor hasNextPage }
            }
          }
        }`,
        {
          fullPath,
          state: upperCaseList(args.state),
          severity: upperCaseList(args.severity),
          reportType: upperCaseList(args.report_type),
          first: getOptionalNumber(args, "first") ?? 20,
          after: getOptionalString(args, "after")
        }
      );

      if (!data.project) {
        throw new Error(`Project '${fullPath}' was not found or is not accessible`);
      }
      return {
        vulnerabilities: data.project.vulnerabilities?.nodes ?? [],
        page_info: {
          end_cursor: data.project.vulnerabilities?.pageInfo?.endCursor ?? null,
          has_next_page: data.project.vulnerabilities?.pageInfo?.hasNextPage ?? false
        }
      };
    }
  },
  {
    name: "gitlab_get_vulnerability",
    title: "Get Vulnerability",
    description:
      "Get one vulnerability with its description, identifiers, links, and location. The vulnerability must belong to project_id. Ultimate.",
    capabilities: readGraphqlCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      vulnerability_id: vulnerabilityIdSchema
    },
    handler: async (args, context) =>
      getProjectVulnerability(
        context,
        resolveProjectId(args, context, true),
        getString(args, "vulnerability_id")
      )
  },
  {
    name: "gitlab_confirm_vulnerability",
    title: "Confirm Vulnerability",
    description:
      "Mark a vulnerability of project_id as confirmed, optionally with a comment. Ultimate.",
    capabilities: writeGraphqlCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      vulnerability_id: vulnerabilityIdSchema,
      comment: commentSchema
    },
    handler: async (args, context) =>
      changeVulnerabilityState(
        context,
        args,
        "vulnerabilityConfirm",
        "VulnerabilityConfirmInput",
        {}
      )
  },
  {
    name: "gitlab_dismiss_vulnerability",
    title: "Dismiss Vulnerability",
    description:
      "Dismiss a vulnerability of project_id with a reason (acceptable_risk, false_positive, used_in_tests, mitigating_control, not_applicable) and an optional comment. Ultimate.",
    capabilities: writeGraphqlCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      vulnerability_id: vulnerabilityIdSchema,
      reason: z.enum([
        "acceptable_risk",
        "false_positive",
        "used_in_tests",
        "mitigating_control",
        "not_applicable"
      ]),
      comment: commentSchema
    },
    handler: async (args, context) =>
      changeVulnerabilityState(context, args, "vulnerabilityDismiss", "VulnerabilityDismissInput", {
        dismissalReason: getString(args, "reason").toUpperCase()
      })
  }
];

export function toVulnerabilityGid(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    return `${VULNERABILITY_GID_PREFIX}${trimmed}`;
  }
  if (
    trimmed.startsWith(VULNERABILITY_GID_PREFIX) &&
    /^\d+$/u.test(trimmed.slice(VULNERABILITY_GID_PREFIX.length))
  ) {
    return trimmed;
  }
  throw new Error(
    `'vulnerability_id' must be a numeric ID or a ${VULNERABILITY_GID_PREFIX}<id> global ID`
  );
}

function upperCaseList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => String(item).toUpperCase());
}

async function resolveProjectFullPath(context: AppContext, projectId: string): Promise<string> {
  if (!/^\d+$/u.test(projectId)) {
    try {
      return decodeURIComponent(projectId);
    } catch {
      return projectId;
    }
  }

  const project = await context.gitlab.getProject(projectId);
  if (!isRecord(project) || typeof project.path_with_namespace !== "string") {
    throw new Error(`Could not resolve the full path of project ${projectId}`);
  }
  return project.path_with_namespace;
}

/**
 * Vulnerability IDs are global, so every tool checks that the vulnerability
 * belongs to the requested (and allowlisted) project before reading or
 * changing it.
 */
async function getProjectVulnerability(
  context: AppContext,
  projectId: string,
  vulnerabilityId: string
): Promise<Record<string, unknown>> {
  const data = await executeGraphqlData<{ vulnerability?: Record<string, unknown> | null }>(
    context,
    `query Vulnerability($id: VulnerabilityID!) {
      vulnerability(id: $id) { ${VULNERABILITY_FIELDS} }
    }`,
    { id: toVulnerabilityGid(vulnerabilityId) }
  );

  const vulnerability = data.vulnerability;
  if (!vulnerability || !(await belongsToProject(context, projectId, vulnerability.project))) {
    throw new Error(`Vulnerability ${vulnerabilityId} was not found in project '${projectId}'`);
  }
  return vulnerability;
}

async function belongsToProject(
  context: AppContext,
  projectId: string,
  project: unknown
): Promise<boolean> {
  if (!isRecord(project)) {
    return false;
  }

  if (/^\d+$/u.test(projectId)) {
    return project.id === `${PROJECT_GID_PREFIX}${projectId}`;
  }

  const fullPath = await resolveProjectFullPath(context, projectId);
  return (
    typeof project.fullPath === "string" &&
    project.fullPath.toLowerCase() === fullPath.toLowerCase()
  );
}

async function changeVulnerabilityState(
  context: AppContext,
  args: ToolArgs,
  mutation: "vulnerabilityConfirm" | "vulnerabilityDismiss",
  inputType: "VulnerabilityConfirmInput" | "VulnerabilityDismissInput",
  extraInput: Record<string, string>
): Promise<unknown> {
  const projectId = resolveProjectId(args, context, true);
  const vulnerability = await getProjectVulnerability(
    context,
    projectId,
    getString(args, "vulnerability_id")
  );
  const comment = getOptionalString(args, "comment");

  const data = await executeGraphqlData<
    Record<string, { vulnerability?: unknown; errors?: string[] } | undefined>
  >(
    context,
    `mutation ChangeVulnerabilityState($input: ${inputType}!) {
      ${mutation}(input: $input) {
        vulnerability { id state confirmedAt dismissedAt dismissalReason }
        errors
      }
    }`,
    {
      input: {
        id: vulnerability.id,
        ...extraInput,
        ...(comment ? { comment } : {})
      }
    }
  );

  const payload = data[mutation];
  if (payload?.errors && payload.errors.length > 0) {
    throw new Error(`GitLab rejected ${mutation}: ${payload.errors.join(", ")}`);
  }
  if (!payload?.vulnerability) {
    throw new Error(`GitLab did not return the vulnerability after ${mutation}`);
  }
  return payload.vulnerability;
}
