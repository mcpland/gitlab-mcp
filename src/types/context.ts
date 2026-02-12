import type { AppEnv } from "../config/env.js";
import type { OutputFormatter } from "../lib/output.js";
import type { ToolPolicyEngine } from "../lib/policy.js";
import type { GitLabClient } from "../lib/gitlab-client.js";
import type { Logger } from "pino";

export interface AppContext {
  env: AppEnv;
  logger: Logger;
  gitlab: GitLabClient;
  policy: ToolPolicyEngine;
  formatter: OutputFormatter;
}
