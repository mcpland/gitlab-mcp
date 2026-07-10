import { createHash, timingSafeEqual } from "node:crypto";

export function verifyMcpHttpBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string
): boolean {
  const presentedToken = parseBearerToken(authorizationHeader);
  if (!presentedToken) {
    return false;
  }

  const presentedDigest = createHash("sha256").update(presentedToken, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

function parseBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const match = /^Bearer[\t ]+(.+)$/i.exec(authorizationHeader.trim());
  const token = match?.[1]?.trim();
  return token && !/[\r\n]/.test(token) ? token : undefined;
}
