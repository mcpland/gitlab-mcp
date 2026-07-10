import { describe, expect, it } from "vitest";

import { normalizeClientIpForRateLimit } from "../src/lib/proxy-client-ip.js";

describe("normalizeClientIpForRateLimit", () => {
  it.each([
    ["160.79.106.36:38914", "160.79.106.36"],
    ["[2001:db8::1]:5678", "2001:db8::/56"],
    ["[2001:db8::1]", "2001:db8::/56"],
    ["1.2.3.4", "1.2.3.4"],
    ["2001:db8::1", "2001:db8::/56"],
    ["::1", "::/56"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["[::ffff:192.0.2.1]:8080", "192.0.2.1"]
  ])("normalizes %s to the bounded key %s", (input, expected) => {
    expect(normalizeClientIpForRateLimit(input)).toBe(expected);
  });

  it("maps addresses in the same IPv6 /56 to one key", () => {
    expect(normalizeClientIpForRateLimit("2001:db8:abcd:1200::1")).toBe(
      normalizeClientIpForRateLimit("2001:db8:abcd:12ff::2")
    );
  });
});
