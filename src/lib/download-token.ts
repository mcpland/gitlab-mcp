import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { GitLabAuthHeader } from "../types/auth.js";

export interface DownloadTokenAuth {
  header: GitLabAuthHeader;
  token: string;
  apiUrl?: string;
}

export interface DownloadTokenResource {
  type: string;
  params: Record<string, string>;
}

export interface DownloadTokenPayload extends DownloadTokenAuth {
  expiresAt: number;
  resource: DownloadTokenResource;
}

export function createDownloadToken(
  auth: DownloadTokenAuth,
  resource: DownloadTokenResource,
  options: {
    secret?: string;
    ttlSeconds: number;
    now?: number;
  }
): string {
  const key = deriveDownloadTokenKey(options.secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = JSON.stringify({
    h: auth.header,
    t: auth.token,
    u: auth.apiUrl,
    e: Math.floor((options.now ?? Date.now()) / 1000) + options.ttlSeconds,
    r: resource.type,
    p: resource.params
  });
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptDownloadToken(
  token: string,
  options: {
    secret?: string;
    now?: number;
  }
): DownloadTokenPayload | undefined {
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length < 29) {
      return undefined;
    }

    const key = deriveDownloadTokenKey(options.secret);
    const iv = bytes.subarray(0, 12);
    const tag = bytes.subarray(12, 28);
    const encrypted = bytes.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(raw) as {
      h?: unknown;
      t?: unknown;
      u?: unknown;
      e?: unknown;
      r?: unknown;
      p?: unknown;
    };

    if (!isGitLabAuthHeader(parsed.h) || typeof parsed.t !== "string") {
      return undefined;
    }

    if (typeof parsed.e !== "number") {
      return undefined;
    }

    if (Math.floor((options.now ?? Date.now()) / 1000) > parsed.e) {
      return undefined;
    }

    if (typeof parsed.r !== "string" || !isStringRecord(parsed.p)) {
      return undefined;
    }

    return {
      header: parsed.h,
      token: parsed.t,
      apiUrl: typeof parsed.u === "string" ? parsed.u : undefined,
      expiresAt: parsed.e,
      resource: {
        type: parsed.r,
        params: parsed.p
      }
    };
  } catch {
    return undefined;
  }
}

export function downloadTokenResourceMatches(
  payload: DownloadTokenPayload,
  resource: DownloadTokenResource
): boolean {
  if (payload.resource.type !== resource.type) {
    return false;
  }

  return stableStringify(payload.resource.params) === stableStringify(resource.params);
}

function deriveDownloadTokenKey(secret: string | undefined): Buffer {
  const normalized = secret?.trim();
  if (normalized) {
    if (normalized.length < 32) {
      throw new Error("GITLAB_DOWNLOAD_TOKEN_SECRET must contain at least 32 characters");
    }

    return createHash("sha256").update(normalized).digest();
  }

  return processKey;
}

function isGitLabAuthHeader(value: unknown): value is GitLabAuthHeader {
  return value === "authorization" || value === "private-token" || value === "job-token";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "string");
}

function stableStringify(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  );
}

const processKey = randomBytes(32);
