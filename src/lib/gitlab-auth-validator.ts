import { createHash } from "node:crypto";

import type { GitLabAuthHeader } from "../types/auth.js";

export interface GitLabAuthValidationInput {
  apiUrl: string;
  header: GitLabAuthHeader;
  token: string;
}

interface GitLabAuthValidatorOptions {
  ttlMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  maxEntries?: number;
  now?: () => number;
}

export interface GitLabAuthValidationResult {
  valid: boolean;
  /**
   * Stable identity of the token owner on this GitLab instance, such as
   * "user:42". Undefined when GitLab did not return an identifiable user.
   */
  principal?: string;
}

interface ValidationCacheEntry extends GitLabAuthValidationResult {
  expiresAt: number;
}

const MAX_IDENTITY_RESPONSE_BYTES = 1_000_000;

export class GitLabAuthValidator {
  private readonly cache = new Map<string, ValidationCacheEntry>();
  private readonly inFlight = new Map<string, Promise<GitLabAuthValidationResult>>();
  private readonly fetchImpl: typeof fetch;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly options: GitLabAuthValidatorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  async validate(input: GitLabAuthValidationInput): Promise<boolean> {
    return (await this.authenticate(input)).valid;
  }

  /**
   * Validate a credential and report which GitLab user owns it. Results are
   * cached for the configured TTL and concurrent lookups are coalesced.
   */
  async authenticate(input: GitLabAuthValidationInput): Promise<GitLabAuthValidationResult> {
    const cacheKey = createCacheKey(input);
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return { valid: cached.valid, principal: cached.principal };
    }
    if (cached) {
      this.cache.delete(cacheKey);
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const validation = this.validateUpstream(input)
      .then((result) => {
        this.setCache(cacheKey, result, this.now());
        return result;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, validation);
    return validation;
  }

  private async validateUpstream(
    input: GitLabAuthValidationInput
  ): Promise<GitLabAuthValidationResult> {
    const paths = input.header === "job-token" ? ["user", "job"] : ["user"];
    for (const path of paths) {
      try {
        const response = await this.fetchImpl(
          new URL(path, `${input.apiUrl.replace(/\/+$/, "")}/`),
          {
            method: "GET",
            headers: buildValidationHeaders(input),
            redirect: "error",
            signal: AbortSignal.timeout(this.options.timeoutMs)
          }
        );
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }

        return { valid: true, principal: await readPrincipal(path, response) };
      } catch {
        return { valid: false };
      }
    }
    return { valid: false };
  }

  private setCache(cacheKey: string, result: GitLabAuthValidationResult, now: number): void {
    this.evictExpired(now);
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(cacheKey, {
      valid: result.valid,
      principal: result.principal,
      expiresAt: now + this.options.ttlMs
    });
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

async function readPrincipal(path: string, response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IDENTITY_RESPONSE_BYTES) {
    await response.body?.cancel();
    return undefined;
  }

  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > MAX_IDENTITY_RESPONSE_BYTES) {
      return undefined;
    }
    body = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const owner =
    path === "job" && typeof record.user === "object" && record.user !== null
      ? (record.user as Record<string, unknown>)
      : record;
  const id = owner.id;
  return (typeof id === "number" && Number.isSafeInteger(id)) ||
    (typeof id === "string" && /^\d+$/u.test(id))
    ? `user:${String(id)}`
    : undefined;
}

function buildValidationHeaders(input: GitLabAuthValidationInput): Headers {
  const headers = new Headers({ Accept: "application/json" });
  if (input.header === "authorization") {
    headers.set("Authorization", `Bearer ${input.token}`);
  } else if (input.header === "private-token") {
    headers.set("Private-Token", input.token);
  } else {
    headers.set("Job-Token", input.token);
  }
  return headers;
}

function createCacheKey(input: GitLabAuthValidationInput): string {
  return createHash("sha256")
    .update(input.apiUrl, "utf8")
    .update("\0")
    .update(input.header, "utf8")
    .update("\0")
    .update(input.token, "utf8")
    .digest("hex");
}
