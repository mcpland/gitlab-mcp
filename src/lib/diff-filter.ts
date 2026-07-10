const MAX_EXCLUDED_PATTERNS = 20;
const MAX_PATTERN_LENGTH = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_VARIABLE_QUANTIFIERS = 1;

export interface DiffPathRecord extends Record<string, unknown> {
  new_path?: unknown;
  old_path?: unknown;
}

export function filterDiffRecords<T extends DiffPathRecord>(
  records: T[],
  patterns: string[] | undefined
): T[] {
  const matchers = compileSafePathPatterns(patterns);
  if (matchers.length === 0) {
    return records;
  }

  return records.filter((record) => {
    const paths = [record.new_path, record.old_path].filter(
      (value): value is string => typeof value === "string"
    );
    return !paths.some((path) =>
      matchers.some((matcher) => matcher.test(path.slice(0, MAX_PATH_LENGTH)))
    );
  });
}

export function filterDiffResponse(value: unknown, patterns: string[] | undefined): unknown {
  if (!patterns || patterns.length === 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return filterDiffRecords(value.filter(isDiffPathRecord), patterns);
  }

  if (!isDiffPathRecord(value)) {
    return value;
  }

  const output = { ...value };
  for (const field of ["diffs", "changes"] as const) {
    const records = output[field];
    if (Array.isArray(records)) {
      output[field] = filterDiffRecords(records.filter(isDiffPathRecord), patterns);
    }
  }
  return output;
}

function compileSafePathPatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  if (patterns.length > MAX_EXCLUDED_PATTERNS) {
    throw new Error(`excluded_file_patterns accepts at most ${MAX_EXCLUDED_PATTERNS} patterns`);
  }

  return patterns.map((pattern) => {
    assertSafeRegexPattern(pattern);
    try {
      return new RegExp(pattern);
    } catch (error) {
      throw new Error(
        `Invalid excluded_file_patterns entry '${pattern}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });
}

function assertSafeRegexPattern(pattern: string): void {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `excluded_file_patterns entries must contain 1-${MAX_PATTERN_LENGTH} characters`
    );
  }

  if (/\\[1-9]|\(\?(?:[=!]|<[=!])/u.test(pattern)) {
    throw new Error("excluded_file_patterns does not allow backreferences or lookarounds");
  }

  let escaped = false;
  let inCharacterClass = false;
  let variableQuantifierCount = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
      continue;
    }
    if (character === "(") {
      continue;
    }
    if (character === ")") {
      if (isQuantifierStart(pattern[index + 1])) {
        throw new Error("excluded_file_patterns does not allow quantified groups");
      }
      continue;
    }
    if (isVariableQuantifier(pattern, index)) {
      variableQuantifierCount += 1;
      if (variableQuantifierCount > MAX_VARIABLE_QUANTIFIERS) {
        throw new Error("excluded_file_patterns allows at most one variable-length quantifier");
      }
    }
  }
}

function isQuantifierStart(value: string | undefined): boolean {
  return value === "*" || value === "+" || value === "?" || value === "{";
}

function isVariableQuantifier(pattern: string, index: number): boolean {
  const character = pattern[index];
  if (character === "*" || character === "+") {
    return true;
  }
  if (character === "?") {
    const previous = pattern[index - 1];
    return previous !== "(" && previous !== "*" && previous !== "+" && previous !== "}";
  }
  if (character !== "{") {
    return false;
  }

  const closingIndex = pattern.indexOf("}", index + 1);
  if (closingIndex < 0) {
    return true;
  }
  return pattern.slice(index + 1, closingIndex).includes(",");
}

function isDiffPathRecord(value: unknown): value is DiffPathRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
