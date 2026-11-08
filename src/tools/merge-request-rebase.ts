import { z } from "zod";

import { optionalProjectIdSchema } from "../lib/tool-schema.js";
import type { AppContext } from "../types/context.js";
import { sleepWithSignal } from "./pipeline-jobs.js";
import {
  getOptionalBoolean,
  getOptionalNumber,
  getString,
  isRecord,
  optionalBoolean,
  projectApiPath,
  resolveProjectId,
  writeCapabilities,
  type GitLabToolDefinitionInput
} from "./shared.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 2_000;
// GitLab accepts PUT .../rebase before Sidekiq picks up the job, so the first
// snapshots can still say rebase_in_progress=false with the old head
// (gitlab-org/gitlab-foss#57481). Re-check a few times before reporting that
// the rebase left the head unchanged.
const UNCHANGED_HEAD_RECHECKS = 3;

export interface RebaseWaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const mergeRequestRebaseToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_rebase_merge_request",
    title: "Rebase Merge Request",
    description: `Rebase a merge request's source branch onto its target (GitLab force-pushes the source branch). With wait=true (default) it polls up to timeout_seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}) and reports previous_sha, sha, head_changed, and merge_error. Use gitlab_get_merge_request_conflicts for conflicts.`,
    capabilities: writeCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      merge_request_iid: z.coerce.string().min(1),
      skip_ci: optionalBoolean,
      wait: optionalBoolean,
      timeout_seconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional()
    },
    handler: async (args, context, call) => {
      const projectId = resolveProjectId(args, context, true);
      const mergeRequestIid = getString(args, "merge_request_iid");
      const before = await context.gitlab.getMergeRequest(projectId, mergeRequestIid);
      const previousSha = readSha(before);
      const skipCi = getOptionalBoolean(args, "skip_ci");

      const accepted = await context.gitlab.put(
        projectApiPath(projectId, "merge_requests", mergeRequestIid, "rebase"),
        skipCi === undefined ? {} : { query: { skip_ci: skipCi } }
      );

      if (getOptionalBoolean(args, "wait") === false) {
        return {
          rebase_in_progress: isRecord(accepted) ? (accepted.rebase_in_progress ?? true) : true,
          previous_sha: previousSha,
          note: "Rebase scheduled; check gitlab_get_merge_request for rebase_in_progress and merge_error."
        };
      }

      return waitForRebase(context, projectId, mergeRequestIid, previousSha, {
        timeoutMs: (getOptionalNumber(args, "timeout_seconds") ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        signal: call?.signal
      });
    }
  }
];

export async function waitForRebase(
  context: AppContext,
  projectId: string,
  mergeRequestIid: string,
  previousSha: string | null,
  options: RebaseWaitOptions
): Promise<Record<string, unknown>> {
  const sleep = options.sleep ?? sleepWithSignal;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let recheck = 0;

  for (;;) {
    options.signal?.throwIfAborted();
    const mergeRequest = await context.gitlab.getMergeRequest(projectId, mergeRequestIid, {
      query: { include_rebase_in_progress: true }
    });
    const record = isRecord(mergeRequest) ? mergeRequest : {};
    const inProgress = record.rebase_in_progress === true;
    const sha = readSha(mergeRequest);
    const mergeError = typeof record.merge_error === "string" ? record.merge_error : null;
    const headChanged = previousSha !== null && sha !== null && sha !== previousSha;
    const remainingMs = deadline - now();

    const settled =
      !inProgress && (headChanged || mergeError !== null || recheck >= UNCHANGED_HEAD_RECHECKS);
    if (settled || remainingMs <= 0) {
      return {
        completed: settled,
        rebase_in_progress: inProgress,
        previous_sha: previousSha,
        sha,
        head_changed: headChanged,
        merge_error: mergeError,
        ...(settled
          ? !headChanged && mergeError === null
            ? { note: "The source branch head did not change; it may already be up to date." }
            : {}
          : { note: "Timed out while GitLab was still rebasing; check again later." })
      };
    }

    if (!inProgress) {
      recheck += 1;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs), options.signal);
  }
}

function readSha(mergeRequest: unknown): string | null {
  if (!isRecord(mergeRequest)) {
    return null;
  }
  if (typeof mergeRequest.sha === "string") {
    return mergeRequest.sha;
  }
  const diffRefs = mergeRequest.diff_refs;
  return isRecord(diffRefs) && typeof diffRefs.head_sha === "string" ? diffRefs.head_sha : null;
}
