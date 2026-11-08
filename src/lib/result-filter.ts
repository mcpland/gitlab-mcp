import { createRequire } from "node:module";

/**
 * Optional JMESPath projection of tool results (GITLAB_ENABLE_JMESPATH).
 * Agents can shrink large GitLab payloads to the fields they need, for
 * example `[].{iid: iid, title: title}` on a list result.
 */

interface JmespathModule {
  search(data: unknown, expression: string): unknown;
  compile(expression: string): unknown;
}

// jmespath is CommonJS and @types/jmespath omits compile(), so load it untyped.
const jmespath = createRequire(import.meta.url)("jmespath") as JmespathModule;

export const JMESPATH_ARGUMENT = "jmespath";
export const MAX_JMESPATH_LENGTH = 1_000;

/** Throw a caller-facing error when the expression does not parse. */
export function assertValidJmespath(expression: string): void {
  try {
    jmespath.compile(expression);
  } catch (error) {
    throw new Error(
      `Invalid jmespath expression: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export type JmespathOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Evaluate an already validated expression; runtime failures are reported, not thrown. */
export function applyJmespath(value: unknown, expression: string): JmespathOutcome {
  try {
    return { ok: true, value: jmespath.search(toPlainJson(value), expression) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Drop non-JSON details (symbols, undefined) so JMESPath sees exactly what clients would. */
function toPlainJson(value: unknown): unknown {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}
