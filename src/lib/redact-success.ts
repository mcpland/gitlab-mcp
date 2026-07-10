import { copyPaginationMetadata } from "./pagination.js";

const OMITTED_SUCCESS_RESPONSE_FIELDS = new Set(["runners_token", "import_url"]);

/**
 * Remove known credential-bearing fields from successful GitLab responses
 * before they are exposed to MCP clients. The allowlist is intentionally
 * narrow: fields such as CI/CD variable `value` are legitimate tool output
 * and must not be removed merely because they may contain secrets.
 */
export function redactSuccessfulResponse<T>(value: T): T {
  if (Array.isArray(value)) {
    return copyPaginationMetadata(
      value,
      value.map((item) => redactSuccessfulResponse(item))
    ) as T;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (OMITTED_SUCCESS_RESPONSE_FIELDS.has(key.toLowerCase())) {
      continue;
    }
    output[key] = redactSuccessfulResponse(item);
  }

  return copyPaginationMetadata(value, output) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
