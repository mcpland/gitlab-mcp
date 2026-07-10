interface FixedWindowRateLimiterOptions {
  limit: number;
  windowMs: number;
  maxEntries?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly maxEntries: number;

  constructor(private readonly options: FixedWindowRateLimiterOptions) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    let entry = this.entries.get(key);
    if (entry && now >= entry.resetAt) {
      this.entries.delete(key);
      entry = undefined;
    }

    if (!entry) {
      this.evictExpired(now);
      if (this.entries.size >= this.maxEntries) {
        return this.decision(false, 0, this.options.windowMs);
      }

      entry = { count: 0, resetAt: now + this.options.windowMs };
      this.entries.set(key, entry);
    }

    const retryAfterMs = Math.max(0, entry.resetAt - now);
    if (entry.count >= this.options.limit) {
      return this.decision(false, 0, retryAfterMs);
    }

    entry.count += 1;
    return this.decision(true, this.options.limit - entry.count, retryAfterMs);
  }

  private decision(allowed: boolean, remaining: number, retryAfterMs: number): RateLimitDecision {
    return {
      allowed,
      limit: this.options.limit,
      remaining,
      retryAfterMs
    };
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }
}
