import { describe, expect, it } from "vitest";

import { verifyMcpHttpBearerToken } from "../src/lib/mcp-http-bearer-auth.js";

describe("verifyMcpHttpBearerToken", () => {
  const token = "correct-mcp-http-token-that-is-long-enough";

  it("accepts an exact bearer token case-insensitively", () => {
    expect(verifyMcpHttpBearerToken(`bearer ${token}`, token)).toBe(true);
  });

  it.each([undefined, "", "Basic abc", "Bearer", "Bearer wrong-token"])(
    "rejects invalid authorization header %s",
    (authorization) => {
      expect(verifyMcpHttpBearerToken(authorization, token)).toBe(false);
    }
  );
});
