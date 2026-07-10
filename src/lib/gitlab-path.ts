const INVALID_PROJECT_PATH_CHARACTER = /[\\?#]/u;
const MAX_PERCENT_DECODE_PASSES = 3;

/**
 * Encode a numeric project ID or namespace/project path exactly once.
 * Clients commonly send either raw slashes or an already URL-encoded path;
 * both forms resolve to the same canonical path segment.
 */
export function encodeGitLabProjectId(value: string): string {
  const decoded = decodeProjectId(value);
  validateDecodedProjectId(decoded);
  return encodeURIComponent(decoded);
}

function decodeProjectId(value: string): string {
  let decoded = value;

  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES && decoded.includes("%"); pass += 1) {
    if (/%(?![0-9a-fA-F]{2})/u.test(decoded)) {
      throw new Error("Invalid GitLab project ID: malformed percent escape");
    }

    decoded = decodeURIComponent(decoded);
  }

  if (/%[0-9a-fA-F]{2}/u.test(decoded)) {
    throw new Error("Invalid GitLab project ID: excessive percent encoding");
  }

  return decoded;
}

function validateDecodedProjectId(value: string): void {
  if (!value || INVALID_PROJECT_PATH_CHARACTER.test(value) || containsControlCharacter(value)) {
    throw new Error("Invalid GitLab project ID");
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Invalid GitLab project ID: path traversal is not allowed");
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
