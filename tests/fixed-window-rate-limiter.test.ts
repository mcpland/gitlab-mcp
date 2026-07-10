import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "../src/lib/fixed-window-rate-limiter.js";

describe("FixedWindowRateLimiter", () => {
  it("resets a key after the window", () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1_000 });

    expect(limiter.consume("client", 0).allowed).toBe(true);
    expect(limiter.consume("client", 500).allowed).toBe(false);
    expect(limiter.consume("client", 1_000).allowed).toBe(true);
  });

  it("fails closed when the bounded key map is full", () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1_000, maxEntries: 1 });

    expect(limiter.consume("first", 0).allowed).toBe(true);
    expect(limiter.consume("second", 500).allowed).toBe(false);
    expect(limiter.consume("second", 1_000).allowed).toBe(true);
  });
});
