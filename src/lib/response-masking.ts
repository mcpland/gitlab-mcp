import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { copyPaginationMetadata } from "./pagination.js";
import { hasNestedQuantifiers } from "./regex.js";

/**
 * Operator-defined masking of GitLab content before it reaches the MCP
 * client (and therefore the model provider): leaked tokens, internal IP
 * addresses, e-mail addresses, customer names, or any keyword or pattern
 * listed in a JSON policy file. Masking applies to every string value in
 * tool results and error text; keys are left intact.
 */

export type BuiltinMaskId = "gitlab-token" | "ipv4" | "ipv6" | "email";

export interface MaskingPolicyFile {
  version: 1;
  builtins?: Partial<Record<BuiltinMaskId, { enabled?: boolean; replacement?: string }>>;
  rules?: Array<
    | { id: string; type: "keyword"; match: string; replacement: string; case_sensitive?: boolean }
    | { id: string; type: "regex"; pattern: string; flags?: string; replacement: string }
  >;
}

interface CompiledMask {
  id: string;
  expression: RegExp;
  replacement: string;
}

const MAX_RULES = 200;
const MAX_PATTERN_LENGTH = 500;
const ALLOWED_FLAGS = /^[imsu]*$/u;

const BUILTINS: Record<
  BuiltinMaskId,
  { pattern: string; flags: string; replacement: string; defaultEnabled: boolean }
> = {
  // Token prefixes from https://docs.gitlab.com/security/tokens/#token-prefixes
  "gitlab-token": {
    pattern: String.raw`\bgl(?:pat|rt|ptt|dt|cbt|soat|oas|agent|ft|imt|wt|ffct)-[A-Za-z0-9_-]{20,}`,
    flags: "g",
    replacement: "[token masked]",
    defaultEnabled: true
  },
  ipv4: {
    pattern: String.raw`\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b`,
    flags: "g",
    replacement: "[IP address]",
    defaultEnabled: false
  },
  ipv6: {
    pattern: String.raw`(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}(?::|[0-9A-Fa-f]{1,4})(?![0-9A-Fa-f:])`,
    flags: "g",
    replacement: "[IP address]",
    defaultEnabled: false
  },
  email: {
    pattern: String.raw`\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b`,
    flags: "g",
    replacement: "[email]",
    defaultEnabled: false
  }
};

export class ResponseMasker {
  private constructor(private readonly masks: readonly CompiledMask[]) {}

  /** Load and validate a policy file; errors name the rule id, never its pattern. */
  static fromFile(filePath: string): ResponseMasker {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(
        `Cannot read GITLAB_RESPONSE_MASKING_FILE: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let policy: unknown;
    try {
      policy = JSON.parse(raw);
    } catch {
      throw new Error("GITLAB_RESPONSE_MASKING_FILE must contain valid JSON");
    }

    return ResponseMasker.fromPolicy(policy);
  }

  static fromPolicy(policy: unknown): ResponseMasker {
    if (!isRecord(policy) || policy.version !== 1) {
      throw new Error("Masking policy must be a JSON object with version 1");
    }

    const masks: CompiledMask[] = [];
    const builtins = isRecord(policy.builtins) ? policy.builtins : {};
    for (const [id, builtin] of Object.entries(BUILTINS)) {
      const override = isRecord(builtins[id]) ? builtins[id] : {};
      const enabled =
        typeof override.enabled === "boolean" ? override.enabled : builtin.defaultEnabled;
      if (enabled) {
        masks.push({
          id,
          expression: new RegExp(builtin.pattern, builtin.flags),
          replacement:
            typeof override.replacement === "string"
              ? escapeReplacement(override.replacement)
              : builtin.replacement
        });
      }
    }
    for (const id of Object.keys(builtins)) {
      if (!(id in BUILTINS)) {
        throw new Error(`Unknown masking builtin '${id}'`);
      }
    }

    const rules = policy.rules === undefined ? [] : policy.rules;
    if (!Array.isArray(rules) || rules.length > MAX_RULES) {
      throw new Error(
        `Masking policy rules must be an array of at most ${String(MAX_RULES)} rules`
      );
    }
    rules.forEach((rule, index) => masks.push(compileRule(rule, index)));

    return new ResponseMasker(masks);
  }

  get ruleCount(): number {
    return this.masks.length;
  }

  maskText(text: string): string {
    let output = text;
    for (const mask of this.masks) {
      mask.expression.lastIndex = 0;
      output = output.replace(mask.expression, mask.replacement);
    }
    return output;
  }

  /** Mask every string in a JSON-like value, preserving structure and pagination metadata. */
  maskValue<T>(value: T): T {
    if (typeof value === "string") {
      return this.maskText(value) as T;
    }
    if (Array.isArray(value)) {
      return copyPaginationMetadata(
        value,
        value.map((item) => this.maskValue(item))
      ) as T;
    }
    if (isRecord(value)) {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = this.maskValue(item);
      }
      return copyPaginationMetadata(value, output) as T;
    }
    return value;
  }
}

function compileRule(rule: unknown, index: number): CompiledMask {
  if (!isRecord(rule) || typeof rule.id !== "string" || rule.id.trim().length === 0) {
    throw new Error(`Masking rule #${String(index + 1)} needs a non-empty string id`);
  }
  const id = rule.id;
  if (typeof rule.replacement !== "string") {
    throw new Error(`Masking rule '${id}' needs a string replacement`);
  }

  if (rule.type === "keyword") {
    if (typeof rule.match !== "string" || rule.match.length === 0) {
      throw new Error(`Masking rule '${id}' needs a non-empty match`);
    }
    return {
      id,
      expression: new RegExp(escapeRegExp(rule.match), rule.case_sensitive === false ? "gi" : "g"),
      replacement: escapeReplacement(rule.replacement)
    };
  }

  if (rule.type === "regex") {
    if (
      typeof rule.pattern !== "string" ||
      rule.pattern.length === 0 ||
      rule.pattern.length > MAX_PATTERN_LENGTH
    ) {
      throw new Error(
        `Masking rule '${id}' needs a pattern of 1 to ${String(MAX_PATTERN_LENGTH)} characters`
      );
    }
    const flags = typeof rule.flags === "string" ? rule.flags.replaceAll("g", "") : "";
    if (!ALLOWED_FLAGS.test(flags)) {
      throw new Error(`Masking rule '${id}' may use only the i, m, s, and u flags`);
    }
    if (hasNestedQuantifiers(rule.pattern)) {
      throw new Error(
        `Masking rule '${id}' uses nested quantifiers, which can backtrack catastrophically`
      );
    }
    try {
      return {
        id,
        expression: new RegExp(rule.pattern, `g${flags}`),
        replacement: rule.replacement
      };
    } catch {
      throw new Error(`Masking rule '${id}' has an invalid regular expression`);
    }
  }

  throw new Error(`Masking rule '${id}' must have type keyword or regex`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Keyword replacements are literal: "$" must not be read as a group reference. */
function escapeReplacement(value: string): string {
  return value.replaceAll("$", "$$");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Load the masker configured by GITLAB_RESPONSE_MASKING_FILE, if any. */
export function loadResponseMasker(
  filePath: string | undefined,
  logger: { info: (obj: Record<string, unknown>, msg: string) => void }
): ResponseMasker | undefined {
  if (!filePath) {
    return undefined;
  }

  const resolved = filePath.startsWith("~/")
    ? resolve(homedir(), filePath.slice(2))
    : resolve(filePath);
  const masker = ResponseMasker.fromFile(resolved);
  logger.info({ rules: masker.ruleCount }, "GitLab response masking enabled");
  return masker;
}
