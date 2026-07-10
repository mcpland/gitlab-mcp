const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_REDIRECT_HEADERS = [
  "authorization",
  "private-token",
  "job-token",
  "cookie",
  "proxy-authorization"
] as const;

export const DEFAULT_MAX_DOWNLOAD_REDIRECTS = 5;

export interface SafeRedirectFetchOptions {
  fetchImpl?: typeof fetch;
  crossOriginFetchImpl?: typeof fetch;
  maxRedirects?: number;
}

/** Follow bounded download redirects without forwarding credentials across origins. */
export async function fetchDownloadWithSafeRedirects(
  initialUrl: URL,
  init: RequestInit,
  options: SafeRedirectFetchOptions = {}
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error("Safe download redirects support only GET or HEAD requests");
  }

  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_DOWNLOAD_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new Error("maxRedirects must be an integer between 0 and 20");
  }

  const sameOriginFetch = options.fetchImpl ?? fetch;
  const crossOriginFetch = options.crossOriginFetchImpl ?? sameOriginFetch;
  let activeFetch = sameOriginFetch;
  let currentUrl = normalizeRedirectUrl(initialUrl, "Initial download URL");
  let headers = new Headers(init.headers);
  let credentialsStripped = false;
  let redirectCount = 0;
  const visited = new Set([redirectIdentity(currentUrl)]);

  for (;;) {
    const response = await activeFetch(currentUrl, {
      ...init,
      method,
      headers,
      redirect: "manual"
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      await cancelResponseBody(response);
      throw new Error(`Download redirect (${String(response.status)}) did not include Location`);
    }
    if (redirectCount >= maxRedirects) {
      await cancelResponseBody(response);
      throw new Error(`Download exceeded the maximum of ${String(maxRedirects)} redirects`);
    }

    let nextUrl: URL;
    try {
      nextUrl = normalizeRedirectUrl(new URL(location, currentUrl), "Download redirect URL");
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }

    const identity = redirectIdentity(nextUrl);
    if (visited.has(identity)) {
      await cancelResponseBody(response);
      throw new Error("Download redirect loop detected");
    }

    if (!credentialsStripped && nextUrl.origin !== currentUrl.origin) {
      headers = stripSensitiveRedirectHeaders(headers);
      credentialsStripped = true;
      activeFetch = crossOriginFetch;
    }

    await cancelResponseBody(response);
    visited.add(identity);
    currentUrl = nextUrl;
    redirectCount += 1;
  }
}

function normalizeRedirectUrl(value: URL, label: string): URL {
  const url = new URL(value.href);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain URL credentials`);
  }
  url.hash = "";
  return url;
}

function redirectIdentity(url: URL): string {
  return url.href;
}

function stripSensitiveRedirectHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const header of SENSITIVE_REDIRECT_HEADERS) {
    headers.delete(header);
  }
  return headers;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Redirect response bodies are discarded best-effort.
  }
}
