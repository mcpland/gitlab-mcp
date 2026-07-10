import { createHash } from "node:crypto";

const GITLAB_GROUP_PATH = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;

export interface OAuthGroupAuthorizerOptions {
  apiUrl: string;
  allowedGroups: string[];
  cacheTtlMs: number;
  cacheMaxEntries: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxPages?: number;
}

interface CacheEntry {
  allowed: boolean;
  expiresAt: number;
}

export class OAuthGroupAuthorizer {
  private readonly allowedGroups: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxPages: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(private readonly options: OAuthGroupAuthorizerOptions) {
    this.allowedGroups = options.allowedGroups.map((group) => group.toLowerCase());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxPages = options.maxPages ?? 100;
  }

  async authorize(token: string): Promise<boolean> {
    if (this.allowedGroups.length === 0) {
      return true;
    }

    const cacheKey = createHash("sha256")
      .update(this.options.apiUrl, "utf8")
      .update("\0")
      .update(token, "utf8")
      .digest("hex");
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.allowed;
    }
    if (cached) {
      this.cache.delete(cacheKey);
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const authorization = this.fetchMembership(token)
      .then((allowed) => {
        this.store(cacheKey, allowed, this.now());
        return allowed;
      })
      .finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, authorization);
    return authorization;
  }

  private async fetchMembership(token: string): Promise<boolean> {
    let page = 1;
    while (page <= this.maxPages) {
      const url = new URL("groups", `${this.options.apiUrl.replace(/\/+$/, "")}/`);
      url.searchParams.set("min_access_level", "10");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));

      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`
          },
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs)
        });
        if (!response.ok) {
          await response.body?.cancel();
          return false;
        }

        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) {
          return false;
        }
        if (payload.some((group) => isAllowedGroup(group, this.allowedGroups))) {
          return true;
        }
        if (payload.length === 0) {
          return false;
        }

        const nextPage = resolveNextPage(response.headers, page, payload.length, this.maxPages);
        if (!nextPage) {
          return false;
        }
        page = nextPage;
      } catch {
        return false;
      }
    }
    return false;
  }

  private store(cacheKey: string, allowed: boolean, now: number): void {
    for (const [key, entry] of this.cache) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key);
      }
    }
    if (this.cache.size >= this.options.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(cacheKey, { allowed, expiresAt: now + this.options.cacheTtlMs });
  }
}

export function parseOAuthAllowedGroups(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const groups = value.split(",").flatMap((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      return [];
    }
    const group = trimmed.replace(/^\/+|\/+$/g, "");
    if (!group) {
      throw new Error(`Invalid GITLAB_OAUTH_ALLOWED_GROUPS entry: '${trimmed}'`);
    }
    return [group];
  });
  const invalid = groups.find(
    (group) =>
      !GITLAB_GROUP_PATH.test(group) ||
      group.split("/").some((segment) => segment === "." || segment === "..")
  );
  if (invalid) {
    throw new Error(`Invalid GITLAB_OAUTH_ALLOWED_GROUPS entry: '${invalid}'`);
  }
  return Array.from(new Set(groups.map((group) => group.toLowerCase())));
}

function isAllowedGroup(value: unknown, allowedGroups: string[]): boolean {
  if (!isRecord(value) || typeof value.full_path !== "string") {
    return false;
  }
  const fullPath = value.full_path.toLowerCase();
  return allowedGroups.some(
    (allowed) => fullPath === allowed || fullPath.startsWith(`${allowed}/`)
  );
}

function resolveNextPage(
  headers: Headers,
  currentPage: number,
  itemCount: number,
  maxPages: number
): number | undefined {
  const rawNextPage = headers.get("x-next-page");
  if (rawNextPage !== null) {
    if (rawNextPage === "") {
      return undefined;
    }
    const nextPage = parsePositiveInteger(rawNextPage);
    return Number.isSafeInteger(nextPage) && nextPage > currentPage && nextPage <= maxPages
      ? nextPage
      : undefined;
  }

  const rawTotalPages = headers.get("x-total-pages");
  if (rawTotalPages !== null) {
    const totalPages = parsePositiveInteger(rawTotalPages);
    if (!Number.isSafeInteger(totalPages) || totalPages < currentPage || totalPages > maxPages) {
      return undefined;
    }
    return currentPage < totalPages ? currentPage + 1 : undefined;
  }

  return itemCount === 100 && currentPage < maxPages ? currentPage + 1 : undefined;
}

function parsePositiveInteger(value: string): number {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
