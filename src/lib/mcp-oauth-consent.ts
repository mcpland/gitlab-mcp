/**
 * Consent page for the MCP OAuth proxy.
 *
 * The proxy forwards every dynamically registered MCP client to one GitLab
 * OAuth application. GitLab can skip its own consent screen for an
 * application the user already authorized, so without a local consent step
 * a link to /authorize with an attacker-registered client could silently
 * deliver the user's authorization to the attacker's redirect URI (the
 * "confused deputy" problem in the MCP security best practices). The user
 * must therefore approve each client and redirect URI here first.
 */

export const CONSENT_CSRF_COOKIE = "mcp_oauth_consent_csrf";
export const CONSENT_GRANT_COOKIE_PREFIX = "mcp_oauth_consent_";

export interface ConsentPageInput {
  serverName: string;
  clientName?: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  gitLabBaseUrl: string;
  formAction: string;
  requestToken: string;
  csrf: string;
}

export function renderConsentPage(input: ConsentPageInput): string {
  const redirect = new URL(input.redirectUri);
  const clientLabel = input.clientName?.trim() || "An unnamed MCP client";
  const shortClientId = `${input.clientId.slice(0, 24)}…`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Authorize ${escapeHtml(clientLabel)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1f1f1f;background:#fff}
h1{font-size:1.3rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem;word-break:break-all}
dt{font-weight:600}
.warn{background:#fff4e5;border:1px solid #f0b46a;padding:.75rem;border-radius:6px}
.actions{display:flex;gap:.75rem;margin-top:1.5rem}
button{font-size:1rem;padding:.55rem 1.2rem;border-radius:6px;border:1px solid #888;background:#f5f5f5;cursor:pointer}
button.approve{background:#1f6feb;border-color:#1f6feb;color:#fff}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}.warn{background:#3a2a12;border-color:#a86b1a}button{background:#222;color:#eee}}
</style>
</head>
<body>
<h1>${escapeHtml(clientLabel)} wants to use your GitLab account through ${escapeHtml(input.serverName)}</h1>
<p class="warn">Approve only if you just started connecting this client yourself. Approving lets it act on GitLab as you with the scopes below.</p>
<dl>
<dt>Client</dt><dd>${escapeHtml(clientLabel)} <small>(${escapeHtml(shortClientId)})</small></dd>
<dt>Returns to</dt><dd><strong>${escapeHtml(redirect.protocol === "https:" || redirect.protocol === "http:" ? redirect.host : redirect.protocol)}</strong><br><small>${escapeHtml(input.redirectUri)}</small></dd>
<dt>GitLab</dt><dd>${escapeHtml(input.gitLabBaseUrl)}</dd>
<dt>Scopes</dt><dd>${escapeHtml(input.scopes.join(", "))}</dd>
</dl>
<form method="post" action="${escapeHtml(input.formAction)}">
<input type="hidden" name="request" value="${escapeHtml(input.requestToken)}">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<div class="actions">
<button class="approve" type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>
</body>
</html>`;
}

/** Headers that keep the consent page from being framed, cached, or scripted. */
export const CONSENT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};

export function consentGrantCookieName(clientHash: string): string {
  return `${CONSENT_GRANT_COOKIE_PREFIX}${clientHash.replace(/[^A-Za-z0-9]/gu, "").slice(0, 16)}`;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { path: string; maxAgeSeconds: number; secure: boolean; sameSite: "Strict" | "Lax" }
): string {
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${String(options.maxAgeSeconds)}`,
    "HttpOnly",
    `SameSite=${options.sameSite}`,
    ...(options.secure ? ["Secure"] : [])
  ].join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
