import { describe, expect, it } from "vitest";

import { getTotalSessions, hasReachedSessionCapacity } from "../src/lib/session-capacity.js";

describe("session capacity helpers", () => {
  it("counts streamable, pending, and SSE sessions together", () => {
    expect(
      getTotalSessions({
        streamableSessions: 2,
        pendingSessions: 1,
        sseSessions: 3,
        maxSessions: 10
      })
    ).toBe(6);
  });

  it("treats capacity as reached when total equals max", () => {
    expect(
      hasReachedSessionCapacity({
        streamableSessions: 1,
        pendingSessions: 1,
        sseSessions: 1,
        maxSessions: 3
      })
    ).toBe(true);
  });

  it("treats capacity as reached when total exceeds max", () => {
    expect(
      hasReachedSessionCapacity({
        streamableSessions: 2,
        pendingSessions: 1,
        sseSessions: 2,
        maxSessions: 4
      })
    ).toBe(true);
  });

  it("does not reach capacity when total is below max", () => {
    expect(
      hasReachedSessionCapacity({
        streamableSessions: 1,
        pendingSessions: 0,
        sseSessions: 1,
        maxSessions: 3
      })
    ).toBe(false);
  });
});
