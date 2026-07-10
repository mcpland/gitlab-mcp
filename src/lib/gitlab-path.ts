const INVALID_PATH_CHARACTER = /[\\?#]/u;
const MAX_PERCENT_DECODE_PASSES = 3;

type GitLabPathIdKind = "project" | "group" | "namespace";

/**
 * Encode a numeric project ID or namespace/project path exactly once.
 * Clients commonly send either raw slashes or an already URL-encoded path;
 * both forms resolve to the same canonical path segment.
 */
export function encodeGitLabProjectId(value: string): string {
  return encodeGitLabPathId(value, "project");
}

/** Compare raw or percent-encoded project identities using their canonical path segment. */
export function isGitLabProjectIdentityAllowed(
  value: string,
  allowedValues: readonly string[]
): boolean {
  const canonicalValue = encodeGitLabProjectId(value);
  return allowedValues.some(
    (allowedValue) => encodeGitLabProjectId(allowedValue) === canonicalValue
  );
}

/** Encode a numeric group ID or nested group path exactly once. */
export function encodeGitLabGroupId(value: string): string {
  return encodeGitLabPathId(value, "group");
}

/** Encode a numeric namespace ID or namespace path exactly once. */
export function encodeGitLabNamespaceId(value: string): string {
  return encodeGitLabPathId(value, "namespace");
}

function encodeGitLabPathId(value: string, kind: GitLabPathIdKind): string {
  const decoded = decodePathId(value, kind);
  validateDecodedPathId(decoded, kind);
  return encodeURIComponent(decoded);
}

function decodePathId(value: string, kind: GitLabPathIdKind): string {
  let decoded = value;

  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES && decoded.includes("%"); pass += 1) {
    if (/%(?![0-9a-fA-F]{2})/u.test(decoded)) {
      throw new Error(`Invalid GitLab ${kind} ID: malformed percent escape`);
    }

    decoded = decodeURIComponent(decoded);
  }

  if (/%[0-9a-fA-F]{2}/u.test(decoded)) {
    throw new Error(`Invalid GitLab ${kind} ID: excessive percent encoding`);
  }

  return decoded;
}

function validateDecodedPathId(value: string, kind: GitLabPathIdKind): void {
  if (!value || INVALID_PATH_CHARACTER.test(value) || containsControlCharacter(value)) {
    throw new Error(`Invalid GitLab ${kind} ID`);
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid GitLab ${kind} ID: path traversal is not allowed`);
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
