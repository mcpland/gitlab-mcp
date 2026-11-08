interface RegexLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

const MAX_DENIED_TOOLS_REGEX_LENGTH = 200;

export function compileDeniedToolsRegex(
  pattern: string | undefined,
  logger: RegexLogger
): RegExp | undefined {
  const normalizedPattern = pattern?.trim();
  if (!normalizedPattern) {
    return undefined;
  }

  if (normalizedPattern.length > MAX_DENIED_TOOLS_REGEX_LENGTH) {
    throwLoggedRegexError(
      logger,
      { patternLength: normalizedPattern.length, maxLength: MAX_DENIED_TOOLS_REGEX_LENGTH },
      `Invalid GITLAB_DENIED_TOOLS_REGEX: pattern exceeds maximum safe length of ${MAX_DENIED_TOOLS_REGEX_LENGTH} characters`
    );
  }

  if (hasNestedQuantifiers(normalizedPattern)) {
    throwLoggedRegexError(
      logger,
      { pattern: normalizedPattern },
      "Invalid GITLAB_DENIED_TOOLS_REGEX: nested quantifiers are not allowed"
    );
  }

  try {
    const regex = new RegExp(normalizedPattern);
    regex.test("gitlab_list_projects");
    return regex;
  } catch (error) {
    throwLoggedRegexError(
      logger,
      {
        pattern: normalizedPattern,
        error: error instanceof Error ? error.message : String(error)
      },
      `Invalid GITLAB_DENIED_TOOLS_REGEX: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function throwLoggedRegexError(
  logger: RegexLogger,
  context: Record<string, unknown>,
  message: string
): never {
  logger.warn(context, message);
  throw new Error(message);
}

interface GroupState {
  containsQuantifiedToken: boolean;
}

/** Detect nested quantifiers such as (a+)+, the usual source of catastrophic backtracking. */
export function hasNestedQuantifiers(pattern: string): boolean {
  const stack: GroupState[] = [];
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (inCharacterClass) {
      if (char === "\\") {
        escaped = true;
      } else if (char === "]") {
        inCharacterClass = false;
      }
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "[") {
      inCharacterClass = true;
      continue;
    }

    if (char === "(") {
      stack.push({ containsQuantifiedToken: false });
      if (pattern[index + 1] === "?") {
        index += 1;
      }
      continue;
    }

    if (char === ")") {
      const group = stack.pop();
      if (!group) {
        continue;
      }

      const quantifierLength = readQuantifier(pattern, index + 1);
      if (quantifierLength === 0) {
        continue;
      }

      if (group.containsQuantifiedToken) {
        return true;
      }

      const parent = stack.at(-1);
      if (parent) {
        parent.containsQuantifiedToken = true;
      }
      index += quantifierLength;
      continue;
    }

    if (stack.length === 0) {
      continue;
    }

    const quantifierLength = readQuantifier(pattern, index);
    if (quantifierLength === 0) {
      continue;
    }

    const currentGroup = stack.at(-1);
    if (currentGroup) {
      currentGroup.containsQuantifiedToken = true;
    }
    index += quantifierLength - 1;
  }

  return false;
}

function readQuantifier(pattern: string, start: number): number {
  if (start >= pattern.length) {
    return 0;
  }

  const char = pattern[start];
  if (char === "*" || char === "+" || char === "?") {
    return pattern[start + 1] === "?" ? 2 : 1;
  }

  if (char !== "{") {
    return 0;
  }

  const match = /^\{\d+(,\d*)?\}\??/.exec(pattern.slice(start));
  return match?.[0].length ?? 0;
}
