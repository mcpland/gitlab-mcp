/**
 * Classify failures where a GitLab request never produced an HTTP response.
 *
 * undici rejects with a bare `TypeError("fetch failed")` and keeps the OS or
 * TLS reason (ECONNREFUSED, ENOTFOUND, UNABLE_TO_VERIFY_LEAF_SIGNATURE, ...)
 * on `error.cause`, so without this the caller only ever sees "fetch failed".
 * AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
 */

export type TransportFailureKind = "tls" | "dns" | "timeout" | "network";

export interface TransportFailure {
  kind: TransportFailureKind;
  code: string | null;
  message: string;
  hint: string;
}

const TLS_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);
const TLS_CODE_PREFIXES = ["CERT_", "ERR_TLS_", "ERR_SSL_"] as const;
const DNS_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT"
]);
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set(["AbortError", "TimeoutError"]);
const UNDICI_FETCH_FAILED_MESSAGE = "fetch failed";

const HINTS: Readonly<Record<TransportFailureKind, string>> = {
  tls: "Make sure GITLAB_CA_CERT_PATH or NODE_EXTRA_CA_CERTS contains the full certificate chain, including intermediate CAs.",
  dns: "Check the host in GITLAB_API_URL and the DNS or proxy settings.",
  timeout:
    "Check that GitLab is reachable from this host and the proxy settings, or raise GITLAB_HTTP_TIMEOUT_MS.",
  network: "Check GITLAB_API_URL, that GitLab is reachable from this host, and the proxy settings."
};

/**
 * Return a classification for errors that mean "no HTTP response arrived",
 * or undefined for everything else (HTTP errors, validation errors, ...).
 */
export function classifyTransportFailure(error: unknown): TransportFailure | undefined {
  const isFetchFailure =
    error instanceof TypeError && error.message === UNDICI_FETCH_FAILED_MESSAGE;
  const isTimeout = isTimeoutSignal(error);
  if (!isFetchFailure && !isTimeout) {
    return undefined;
  }

  const code = readTransportCode(error);
  const kind: TransportFailureKind =
    code !== null
      ? kindFromCode(code)
      : isTimeout || isTimeoutSignal(readCause(error))
        ? "timeout"
        : "network";

  return {
    kind,
    code,
    message: readTransportMessage(error),
    hint: HINTS[kind]
  };
}

/**
 * Human-readable description such as "GitLab request failed before an HTTP
 * response (ECONNREFUSED): fetch failed: connect ECONNREFUSED 10.0.0.5:443.
 * Check GITLAB_API_URL, ...".
 */
export function describeTransportFailure(failure: TransportFailure): string {
  return `GitLab request failed before an HTTP response (${failure.code ?? failure.kind}): ${failure.message}. ${failure.hint}`;
}

function kindFromCode(code: string): TransportFailureKind {
  if (TLS_CODES.has(code) || TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return "tls";
  }
  if (DNS_CODES.has(code)) {
    return "dns";
  }
  if (TIMEOUT_CODES.has(code)) {
    return "timeout";
  }
  return "network";
}

function readTransportCode(error: unknown): string | null {
  const cause = readCause(error);
  const nestedCause = readCause(cause);
  return (
    readStringField(error, "code") ??
    readStringField(cause, "code") ??
    readStringField(nestedCause, "code") ??
    readStringField(cause, "errno")
  );
}

function isTimeoutSignal(value: unknown): boolean {
  const name = readStringField(value, "name");
  return name !== null && TIMEOUT_ERROR_NAMES.has(name);
}

function readTransportMessage(error: unknown): string {
  const outer = readStringField(error, "message");
  const inner = readStringField(readCause(error), "message");
  if (outer && inner && !outer.includes(inner)) {
    return `${outer}: ${inner}`;
  }
  return outer ?? inner ?? "no response";
}

function readCause(value: unknown): unknown {
  return isRecord(value) ? value.cause : undefined;
}

function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const field = value[key];
  if (typeof field !== "string") {
    return null;
  }
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
