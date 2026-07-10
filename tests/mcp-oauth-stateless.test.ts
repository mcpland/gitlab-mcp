import { describe, expect, it } from "vitest";

import { parseMcpOAuthKeyRing, StatelessMcpOAuthCodec } from "../src/lib/mcp-oauth-stateless.js";

const CURRENT_SECRET = Buffer.alloc(32, 1).toString("base64url");
const PREVIOUS_SECRET = Buffer.alloc(32, 2).toString("base64url");

describe("parseMcpOAuthKeyRing", () => {
  it("accepts 32-byte base64url secrets and a distinct rotation key", () => {
    const keyRing = parseMcpOAuthKeyRing(CURRENT_SECRET, PREVIOUS_SECRET);
    expect(keyRing.current).toHaveLength(32);
    expect(keyRing.previous).toHaveLength(32);
  });

  it.each(["not base64!", Buffer.alloc(31).toString("base64url"), "a"])(
    "rejects malformed or undersized secret %s",
    (secret) => {
      expect(() => parseMcpOAuthKeyRing(secret)).toThrow();
    }
  );

  it("rejects a duplicate previous key", () => {
    expect(() => parseMcpOAuthKeyRing(CURRENT_SECRET, CURRENT_SECRET)).toThrow("must differ");
  });
});

describe("StatelessMcpOAuthCodec", () => {
  it("detects tampering, expiry, future-issued values, and purpose confusion", () => {
    const keyRing = parseMcpOAuthKeyRing(CURRENT_SECRET);
    const minter = new StatelessMcpOAuthCodec({
      keyRing,
      clientTtlSeconds: 600,
      codeTtlSeconds: 60,
      now: () => 2_000
    });
    const clientId = minter.sealClient({
      client_id: "pending",
      redirect_uris: ["https://client.example.com/callback"],
      token_endpoint_auth_method: "none"
    });
    const state = minter.sealAuthorizationState({
      clientId,
      clientRedirectUri: "https://client.example.com/callback",
      clientCodeChallenge: "c".repeat(43),
      proxyCodeVerifier: "p".repeat(43),
      clientState: "client-state"
    });
    const code = minter.sealAuthorizationCode({
      gitLabCode: "gitlab-code",
      clientHash: "client-hash",
      clientRedirectUri: "https://client.example.com/callback",
      clientCodeChallenge: "c".repeat(43),
      proxyCodeVerifier: "p".repeat(43)
    });

    const currentVerifier = new StatelessMcpOAuthCodec({
      keyRing,
      clientTtlSeconds: 600,
      codeTtlSeconds: 60,
      now: () => 2_030
    });
    expect(currentVerifier.openClient(clientId)?.redirect_uris).toEqual([
      "https://client.example.com/callback"
    ]);
    expect(currentVerifier.openAuthorizationState(state)?.clientState).toBe("client-state");
    expect(currentVerifier.openAuthorizationCode(code)?.gitLabCode).toBe("gitlab-code");
    expect(currentVerifier.openAuthorizationCode(state)).toBeUndefined();
    expect(currentVerifier.openAuthorizationState(tamper(state))).toBeUndefined();

    const expiredVerifier = new StatelessMcpOAuthCodec({
      keyRing,
      clientTtlSeconds: 600,
      codeTtlSeconds: 60,
      now: () => 2_061
    });
    expect(expiredVerifier.openAuthorizationState(state)).toBeUndefined();
    expect(expiredVerifier.openAuthorizationCode(code)).toBeUndefined();

    const behindClockVerifier = new StatelessMcpOAuthCodec({
      keyRing,
      clientTtlSeconds: 600,
      codeTtlSeconds: 60,
      now: () => 1_939
    });
    expect(behindClockVerifier.openClient(clientId)).toBeUndefined();
  });

  it("opens in-flight values with the previous key while minting with the current key", () => {
    const oldKeyRing = parseMcpOAuthKeyRing(PREVIOUS_SECRET);
    const oldCodec = new StatelessMcpOAuthCodec({
      keyRing: oldKeyRing,
      clientTtlSeconds: 600,
      codeTtlSeconds: 60,
      now: () => 3_000
    });
    const oldState = oldCodec.sealAuthorizationState({
      clientId: "old-client",
      clientRedirectUri: "https://client.example.com/callback",
      clientCodeChallenge: "c".repeat(43),
      proxyCodeVerifier: "p".repeat(43)
    });

    const rotatingCodec = new StatelessMcpOAuthCodec({
      keyRing: parseMcpOAuthKeyRing(CURRENT_SECRET, PREVIOUS_SECRET),
      clientTtlSeconds: 600,
      codeTtlSeconds: 60,
      now: () => 3_010
    });
    expect(rotatingCodec.openAuthorizationState(oldState)).toBeDefined();
    const newState = rotatingCodec.sealAuthorizationState({
      clientId: "new-client",
      clientRedirectUri: "https://client.example.com/callback",
      clientCodeChallenge: "c".repeat(43),
      proxyCodeVerifier: "p".repeat(43)
    });
    expect(oldCodec.openAuthorizationState(newState)).toBeUndefined();
  });

  it("binds sealed refresh tokens to a client hash", () => {
    const codec = new StatelessMcpOAuthCodec({
      keyRing: parseMcpOAuthKeyRing(CURRENT_SECRET),
      clientTtlSeconds: 600,
      codeTtlSeconds: 60,
      now: () => 4_000
    });
    const refreshToken = codec.sealRefreshToken("gitlab-refresh", "client-one");
    const opened = codec.openRefreshToken(refreshToken);
    expect(opened?.gitLabRefreshToken).toBe("gitlab-refresh");
    expect(opened?.clientHash).toHaveLength(43);
    expect(codec.openRefreshToken(tamper(refreshToken))).toBeUndefined();
  });
});

function tamper(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
}
