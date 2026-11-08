import { z } from "zod";

import { optionalProjectIdSchema } from "../lib/tool-schema.js";
import {
  deleteCapabilities,
  getOptionalNumber,
  getString,
  isRecord,
  projectApiPath,
  readCapabilities,
  resolveProjectId,
  type GitLabToolDefinitionInput
} from "./shared.js";

const DEFAULT_WAIT_TIMEOUT_SECONDS = 60;
const MAX_WAIT_TIMEOUT_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Statuses after which a pipeline or job will not progress without user action. */
export const TERMINAL_PIPELINE_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual"
]);
export const TERMINAL_JOB_STATUSES: ReadonlySet<string> = TERMINAL_PIPELINE_STATUSES;

const waitShape = {
  timeout_seconds: z.number().int().min(1).max(MAX_WAIT_TIMEOUT_SECONDS).optional(),
  poll_interval_seconds: z.number().int().min(1).max(30).optional()
};

export const pipelineJobToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_wait_for_pipeline",
    title: "Wait for Pipeline",
    description: `Poll a pipeline until it reaches success, failed, canceled, skipped, or manual, or until timeout_seconds (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}, max ${MAX_WAIT_TIMEOUT_SECONDS}) elapses. Returns completed=false with the last status on timeout; call again to keep waiting.`,
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_id: z.coerce.string().min(1),
      ...waitShape
    },
    handler: async (args, context, call) => {
      const projectId = resolveProjectId(args, context, true);
      const pipelineId = getString(args, "pipeline_id");
      const outcome = await waitForTerminalStatus({
        fetch: () => context.gitlab.getPipeline(projectId, pipelineId),
        terminalStatuses: TERMINAL_PIPELINE_STATUSES,
        ...waitOptions(args),
        signal: call?.signal
      });
      return { ...outcome.summary, pipeline: outcome.value };
    }
  },
  {
    name: "gitlab_wait_for_job",
    title: "Wait for Job",
    description: `Poll a job until it reaches success, failed, canceled, skipped, or manual, or until timeout_seconds (default ${DEFAULT_WAIT_TIMEOUT_SECONDS}, max ${MAX_WAIT_TIMEOUT_SECONDS}) elapses. Returns completed=false with the last status on timeout; call again to keep waiting.`,
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      job_id: z.coerce.string().min(1),
      ...waitShape
    },
    handler: async (args, context, call) => {
      const projectId = resolveProjectId(args, context, true);
      const jobId = getString(args, "job_id");
      const outcome = await waitForTerminalStatus({
        fetch: () => context.gitlab.getPipelineJob(projectId, jobId),
        terminalStatuses: TERMINAL_JOB_STATUSES,
        ...waitOptions(args),
        signal: call?.signal
      });
      return { ...outcome.summary, job: outcome.value };
    }
  },
  {
    name: "gitlab_erase_pipeline_job",
    title: "Erase Pipeline Job",
    description:
      "Erase a finished job's log and artifacts permanently; the job record remains. Irreversible. Requires job_id. Recommended pre-check: gitlab_get_pipeline_job.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      job_id: z.coerce.string().min(1)
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(
          resolveProjectId(args, context, true),
          "jobs",
          getString(args, "job_id"),
          "erase"
        )
      )
  }
];

function waitOptions(args: Record<string, unknown>): { timeoutMs: number; intervalMs: number } {
  return {
    timeoutMs: (getOptionalNumber(args, "timeout_seconds") ?? DEFAULT_WAIT_TIMEOUT_SECONDS) * 1000,
    intervalMs:
      (getOptionalNumber(args, "poll_interval_seconds") ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000
  };
}

export interface WaitForStatusOptions {
  fetch: () => Promise<unknown>;
  terminalStatuses: ReadonlySet<string>;
  timeoutMs: number;
  intervalMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface WaitForStatusOutcome {
  value: unknown;
  summary: {
    completed: boolean;
    status: string | null;
    polls: number;
    waited_seconds: number;
    note?: string;
  };
}

/**
 * Poll until the resource reports a terminal status or the deadline passes.
 * The last observed resource is returned either way so the caller can decide
 * whether to keep waiting; client cancellation stops polling immediately.
 */
export async function waitForTerminalStatus(
  options: WaitForStatusOptions
): Promise<WaitForStatusOutcome> {
  const sleep = options.sleep ?? sleepWithSignal;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + options.timeoutMs;
  let polls = 0;

  for (;;) {
    options.signal?.throwIfAborted();
    const value = await options.fetch();
    polls += 1;
    const status = isRecord(value) && typeof value.status === "string" ? value.status : null;
    const completed = status !== null && options.terminalStatuses.has(status);
    const remainingMs = deadline - now();

    if (completed || remainingMs <= 0) {
      return {
        value,
        summary: {
          completed,
          status,
          polls,
          waited_seconds: Math.round((now() - startedAt) / 1000),
          ...(completed
            ? {}
            : { note: "Timed out before a terminal status; call again to keep waiting." })
        }
      };
    }

    await sleep(Math.min(options.intervalMs, remainingMs), options.signal);
  }
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
