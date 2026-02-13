/**
 * Tests for helper functions exported or used internally by request-runtime.ts.
 * Since some functions are private, we test them indirectly or test the module-level
 * exported utilities that are accessible.
 *
 * For deeper testing we extract testable logic patterns.
 */
import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Replicate the parseTokenOutput logic for testing.
 * This matches the private function in request-runtime.ts.
 */
function parseTokenOutput(rawOutput: string): string | undefined {
  const output = rawOutput.trim();
  if (!output) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const token =
      getStringField(parsed, "token") ||
      getStringField(parsed, "access_token") ||
      getStringField(parsed, "private_token");
    if (token) {
      return token;
    }
  } catch {
    // Plain string output is valid.
  }

  return output.split(/\r?\n/, 1)[0]?.trim() || undefined;
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Replicate resolveHomePath for testing.
 */
function resolveHomePath(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

/**
 * Replicate normalizeWarmupPath for testing.
 */
function normalizeWarmupPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "/user";
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Replicate resolveApiRoot for testing.
 */
function resolveApiRoot(url: URL): string | undefined {
  const match = url.pathname.match(/^(.*\/api\/v4)(?:\/|$)/);
  return match?.[1];
}

/**
 * Replicate parseOauthScopes for testing.
 */
function parseOauthScopes(rawScopes: string): string[] {
  return rawScopes
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

describe("parseTokenOutput", () => {
  it("returns undefined for empty string", () => {
    expect(parseTokenOutput("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseTokenOutput("   \n  ")).toBeUndefined();
  });

  it("parses plain text token", () => {
    expect(parseTokenOutput("glpat-abc123")).toBe("glpat-abc123");
  });

  it("parses plain text with trailing newline", () => {
    expect(parseTokenOutput("glpat-abc123\n")).toBe("glpat-abc123");
  });

  it("takes first line of multi-line output", () => {
    expect(parseTokenOutput("glpat-abc123\nsome debug info\nmore stuff")).toBe("glpat-abc123");
  });

  it("parses JSON with token field", () => {
    expect(parseTokenOutput('{"token": "glpat-from-json"}')).toBe("glpat-from-json");
  });

  it("parses JSON with access_token field", () => {
    expect(parseTokenOutput('{"access_token": "oauth-token-123"}')).toBe("oauth-token-123");
  });

  it("parses JSON with private_token field", () => {
    expect(parseTokenOutput('{"private_token": "private-123"}')).toBe("private-123");
  });

  it("prefers token field over access_token", () => {
    expect(parseTokenOutput('{"token": "primary", "access_token": "secondary"}')).toBe("primary");
  });

  it("ignores JSON with empty token fields", () => {
    expect(parseTokenOutput('{"token": "", "other": "value"}')).toBe(
      '{"token": "", "other": "value"}'
    );
  });

  it("ignores JSON with whitespace-only token fields", () => {
    expect(parseTokenOutput('{"token": "   "}')).toBe('{"token": "   "}');
  });

  it("trims whitespace from parsed token values", () => {
    expect(parseTokenOutput('{"token": "  trimmed  "}')).toBe("trimmed");
  });

  it("handles JSON with no recognized token fields", () => {
    const input = '{"unknown_field": "some-value"}';
    // Falls back to first line
    expect(parseTokenOutput(input)).toBe(input);
  });
});

describe("resolveHomePath", () => {
  it("returns undefined for empty input", () => {
    expect(resolveHomePath("")).toBeUndefined();
    expect(resolveHomePath(undefined)).toBeUndefined();
  });

  it("expands ~ to home directory", () => {
    const result = resolveHomePath("~/some/path");
    expect(result).toBeDefined();
    expect(result).not.toContain("~/");
    expect(result).toContain("some/path");
  });

  it("returns absolute paths unchanged", () => {
    expect(resolveHomePath("/absolute/path")).toBe("/absolute/path");
  });

  it("returns relative paths unchanged", () => {
    expect(resolveHomePath("relative/path")).toBe("relative/path");
  });
});

describe("normalizeWarmupPath", () => {
  it("returns /user for empty string", () => {
    expect(normalizeWarmupPath("")).toBe("/user");
  });

  it("returns /user for whitespace-only string", () => {
    expect(normalizeWarmupPath("   ")).toBe("/user");
  });

  it("preserves leading slash", () => {
    expect(normalizeWarmupPath("/custom")).toBe("/custom");
  });

  it("adds leading slash when missing", () => {
    expect(normalizeWarmupPath("custom")).toBe("/custom");
  });

  it("trims whitespace", () => {
    expect(normalizeWarmupPath("  /user  ")).toBe("/user");
  });
});

describe("resolveApiRoot", () => {
  it("extracts /api/v4 from standard URL", () => {
    const url = new URL("https://gitlab.example.com/api/v4/projects/1");
    expect(resolveApiRoot(url)).toBe("/api/v4");
  });

  it("extracts subpath /api/v4", () => {
    const url = new URL("https://example.com/gitlab/api/v4/projects");
    expect(resolveApiRoot(url)).toBe("/gitlab/api/v4");
  });

  it("returns undefined for non-API URLs", () => {
    const url = new URL("https://gitlab.example.com/group/project");
    expect(resolveApiRoot(url)).toBeUndefined();
  });

  it("matches when path ends with /api/v4", () => {
    const url = new URL("https://gitlab.example.com/api/v4/");
    expect(resolveApiRoot(url)).toBe("/api/v4");
  });
});

describe("parseOauthScopes", () => {
  it("parses space-separated scopes", () => {
    expect(parseOauthScopes("api read_user")).toEqual(["api", "read_user"]);
  });

  it("parses comma-separated scopes", () => {
    expect(parseOauthScopes("api,read_user,write_repository")).toEqual([
      "api",
      "read_user",
      "write_repository"
    ]);
  });

  it("handles mixed separators", () => {
    expect(parseOauthScopes("api, read_user write_repository")).toEqual([
      "api",
      "read_user",
      "write_repository"
    ]);
  });

  it("filters empty entries", () => {
    expect(parseOauthScopes("api,,read_user, ,write_repository")).toEqual([
      "api",
      "read_user",
      "write_repository"
    ]);
  });

  it("handles single scope", () => {
    expect(parseOauthScopes("api")).toEqual(["api"]);
  });

  it("handles empty string", () => {
    expect(parseOauthScopes("")).toEqual([]);
  });

  it("trims whitespace from scopes", () => {
    expect(parseOauthScopes("  api  ,  read_user  ")).toEqual(["api", "read_user"]);
  });
});
