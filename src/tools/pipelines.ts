import { z } from "zod";

import { copyPaginationMetadata } from "../lib/pagination.js";
import { nullableOptional, optionalProjectIdSchema } from "../lib/tool-schema.js";
import {
  deleteCapabilities,
  getOptionalBoolean,
  getOptionalStringArray,
  getString,
  isRecord,
  jsonBody,
  optionalBoolean,
  paginationShape,
  pickPresentFields,
  projectApiPath,
  readCapabilities,
  resolveProjectId,
  toQuery,
  writeCapabilities,
  type GitLabToolDefinitionInput,
  type ToolArgs
} from "./shared.js";

const pipelineIdSchema = z.coerce.string().min(1);
const testCaseStatusSchema = z.enum(["success", "failed", "error", "skipped"]);
const PIPELINE_VARIABLE_SAFE_FIELDS = ["key", "variable_type", "raw"] as const;

export const pipelineToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_get_pipeline_test_report",
    title: "Get Pipeline Test Report",
    description:
      'Get the unit test report for a pipeline: totals plus each suite\'s test cases with status, timing, and stack traces. Pass test_case_status (for example ["failed","error"]) to keep only matching cases.',
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_id: pipelineIdSchema,
      test_case_status: nullableOptional(z.array(testCaseStatusSchema).min(1).max(4))
    },
    handler: async (args, context) =>
      filterTestReport(
        await context.gitlab.get(
          projectApiPath(
            resolveProjectId(args, context, true),
            "pipelines",
            getString(args, "pipeline_id"),
            "test_report"
          )
        ),
        getOptionalStringArray(args, "test_case_status")
      )
  },
  {
    name: "gitlab_get_pipeline_test_report_summary",
    title: "Get Pipeline Test Report Summary",
    description:
      "Get per-suite test counts and totals for a pipeline without individual test cases. Use gitlab_get_pipeline_test_report for failures.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_id: pipelineIdSchema
    },
    handler: async (args, context) =>
      context.gitlab.get(
        projectApiPath(
          resolveProjectId(args, context, true),
          "pipelines",
          getString(args, "pipeline_id"),
          "test_report_summary"
        )
      )
  },
  {
    name: "gitlab_get_pipeline_variables",
    title: "Get Pipeline Variables",
    description:
      "List the variables a pipeline was started with. Values require GITLAB_ALLOW_CI_VARIABLE_VALUES=true and include_value=true.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_id: pipelineIdSchema,
      include_value: optionalBoolean,
      ...paginationShape
    },
    handler: async (args, context) =>
      pipelineVariableResponse(
        await context.gitlab.get(
          projectApiPath(
            resolveProjectId(args, context, true),
            "pipelines",
            getString(args, "pipeline_id"),
            "variables"
          ),
          { query: toQuery(pickPresentFields(args, ["page", "per_page"])) }
        ),
        context.env.GITLAB_ALLOW_CI_VARIABLE_VALUES &&
          getOptionalBoolean(args, "include_value") === true
      )
  },
  {
    name: "gitlab_update_pipeline_metadata",
    title: "Update Pipeline Metadata",
    description: "Rename a pipeline. Only the pipeline name can be changed.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_id: pipelineIdSchema,
      name: z.string().min(1).max(255)
    },
    handler: async (args, context) =>
      context.gitlab.put(
        projectApiPath(
          resolveProjectId(args, context, true),
          "pipelines",
          getString(args, "pipeline_id"),
          "metadata"
        ),
        jsonBody({ name: getString(args, "name") })
      )
  },
  {
    name: "gitlab_delete_pipeline",
    title: "Delete Pipeline",
    description:
      "Delete a pipeline and its job logs, artifacts, and test reports permanently. Irreversible. Requires pipeline_id. Recommended pre-check: gitlab_get_pipeline.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_id: pipelineIdSchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const pipelineId = getString(args, "pipeline_id");
      await context.gitlab.delete(projectApiPath(projectId, "pipelines", pipelineId));
      return { status: "deleted", project_id: projectId, pipeline_id: pipelineId };
    }
  }
];

/**
 * Test reports for large suites can be megabytes; keeping only the requested
 * case statuses lets an agent read every failure without truncation.
 * Suite and report counters are preserved so totals stay accurate.
 */
function filterTestReport(report: unknown, statuses: string[] | undefined): unknown {
  if (!statuses || !isRecord(report) || !Array.isArray(report.test_suites)) {
    return report;
  }

  const wanted = new Set(statuses);
  const suites = report.test_suites.flatMap((suite) => {
    if (!isRecord(suite) || !Array.isArray(suite.test_cases)) {
      return [];
    }

    const cases = suite.test_cases.filter(
      (testCase) =>
        isRecord(testCase) && typeof testCase.status === "string" && wanted.has(testCase.status)
    );
    return cases.length > 0 || suite.suite_error ? [{ ...suite, test_cases: cases }] : [];
  });

  return { ...report, test_suites: suites, test_case_status_filter: [...wanted] };
}

function pipelineVariableResponse(value: unknown, includeValue: boolean): unknown {
  if (includeValue || !Array.isArray(value)) {
    return value;
  }

  return copyPaginationMetadata(
    value,
    value.map((variable) => {
      if (!isRecord(variable)) {
        return variable;
      }
      const output: ToolArgs = {};
      for (const field of PIPELINE_VARIABLE_SAFE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(variable, field)) {
          output[field] = variable[field];
        }
      }
      return output;
    })
  );
}
