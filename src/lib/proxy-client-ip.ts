import { isIPv4, isIPv6 } from "node:net";

const IPV4_WITH_PORT_PATTERN = /^(\d+(?:\.\d+){3}):\d+$/;
const BRACKETED_IPV6_PATTERN = /^\[([^\]]+)\](?::\d+)?$/;

export function normalizeClientIpForRateLimit(rawIp: string): string {
  const normalized = rawIp
    .trim()
    .replace(IPV4_WITH_PORT_PATTERN, "$1")
    .replace(BRACKETED_IPV6_PATTERN, "$1");

  if (isIPv4(normalized)) {
    return normalized;
  }
  if (!isIPv6(normalized)) {
    return normalized || "unknown";
  }

  const bytes = parseIpv6Bytes(normalized);
  if (!bytes) {
    return normalized;
  }
  if (isIpv4MappedAddress(bytes)) {
    return `${String(bytes[12])}.${String(bytes[13])}.${String(bytes[14])}.${String(bytes[15])}`;
  }

  bytes.fill(0, 7);
  return `${formatIpv6(bytes)}/56`;
}

function parseIpv6Bytes(address: string): Uint8Array | undefined {
  const withoutZone = address.split("%", 1)[0] ?? address;
  let normalized = withoutZone;
  const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const octets = dottedTail.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
      return undefined;
    }
    const replacement = `${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
    normalized = `${normalized.slice(0, -dottedTail.length)}${replacement}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const left = splitHextets(halves[0] ?? "");
  const right = splitHextets(halves[1] ?? "");
  if (!left || !right) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  const hextets = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (hextets.length !== 8) {
    return undefined;
  }

  const bytes = new Uint8Array(16);
  hextets.forEach((hextet, index) => {
    bytes[index * 2] = hextet >> 8;
    bytes[index * 2 + 1] = hextet & 0xff;
  });
  return bytes;
}

function splitHextets(value: string): number[] | undefined {
  if (!value) {
    return [];
  }
  const parts = value.split(":");
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return undefined;
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

function isIpv4MappedAddress(bytes: Uint8Array): boolean {
  return (
    bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  );
}

function formatIpv6(bytes: Uint8Array): string {
  const hextets = Array.from({ length: 8 }, (_, index) =>
    (((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0)).toString(16)
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < hextets.length; ) {
    if (hextets[start] !== "0") {
      start += 1;
      continue;
    }
    let end = start;
    while (end < hextets.length && hextets[end] === "0") {
      end += 1;
    }
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestLength < 2) {
    return hextets.join(":");
  }
  const before = hextets.slice(0, bestStart).join(":");
  const after = hextets.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`;
}
