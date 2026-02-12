export function stripNullsDeep<T>(value: T): T {
  if (value === null) {
    return undefined as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripNullsDeep(item)).filter((item) => item !== undefined) as T;
  }

  if (typeof value === "object" && value !== undefined) {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(input)) {
      const normalized = stripNullsDeep(item);
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }

    return output as T;
  }

  return value;
}
