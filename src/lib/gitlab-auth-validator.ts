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

interface ValidationCacheEntry {
  valid: boolean;
  expiresAt: number;
}

export class GitLabAuthValidator {
  private readonly cache = new Map<string, ValidationCacheEntry>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly fetchImpl: typeof fetch;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly options: GitLabAuthValidatorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  async validate(input: GitLabAuthValidationInput): Promise<boolean> {
    const cacheKey = createCacheKey(input);
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.valid;
    }
    if (cached) {
      this.cache.delete(cacheKey);
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const validation = this.validateUpstream(input)
      .then((valid) => {
        this.setCache(cacheKey, valid, this.now());
        return valid;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, validation);
    return validation;
  }

  private async validateUpstream(input: GitLabAuthValidationInput): Promise<boolean> {
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
        const valid = response.ok;
        await response.body?.cancel();
        if (valid) {
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  private setCache(cacheKey: string, valid: boolean, now: number): void {
    this.evictExpired(now);
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(cacheKey, { valid, expiresAt: now + this.options.ttlMs });
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
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
