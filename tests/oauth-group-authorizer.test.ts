import { describe, expect, it, vi } from "vitest";

import {
  OAuthGroupAuthorizer,
  parseOAuthAllowedGroups
} from "../src/lib/oauth-group-authorizer.js";

describe("OAuthGroupAuthorizer", () => {
  it("matches group full paths and descendants case-insensitively across pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      full_path: `unrelated/group-${String(index)}`
    }));
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const page = new URL(String(input)).searchParams.get("page");
      if (page === "1") {
        return Response.json(firstPage, { headers: { "x-next-page": "2" } });
      }
      return Response.json([{ full_path: "My-Org/Engineering/Backend" }], {
        headers: { "x-next-page": "" }
      });
    });
    const authorizer = new OAuthGroupAuthorizer({
      apiUrl: "https://gitlab.example.com/api/v4",
      allowedGroups: ["my-org/engineering"],
      cacheTtlMs: 60_000,
      cacheMaxEntries: 100,
      timeoutMs: 5_000,
      fetchImpl
    });

    await expect(authorizer.authorize("oauth-token")).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([new Response("unauthorized", { status: 401 }), Response.json({ full_path: "my-org" })])(
    "fails closed for rejected or malformed group responses",
    async (response) => {
      const authorizer = new OAuthGroupAuthorizer({
        apiUrl: "https://gitlab.example.com/api/v4",
        allowedGroups: ["my-org"],
        cacheTtlMs: 60_000,
        cacheMaxEntries: 100,
        timeoutMs: 5_000,
        fetchImpl: vi.fn<typeof fetch>(async () => response)
      });

      await expect(authorizer.authorize("oauth-token")).resolves.toBe(false);
    }
  );

  it("bounds and expires its token-digest cache", async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json([{ full_path: "my-org" }], { headers: { "x-next-page": "" } })
    );
    const authorizer = new OAuthGroupAuthorizer({
      apiUrl: "https://gitlab.example.com/api/v4",
      allowedGroups: ["my-org"],
      cacheTtlMs: 1_000,
      cacheMaxEntries: 1,
      timeoutMs: 5_000,
      fetchImpl,
      now: () => now
    });

    await authorizer.authorize("token-1");
    await authorizer.authorize("token-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await authorizer.authorize("token-2");
    await authorizer.authorize("token-1");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    now = 1_000;
    await authorizer.authorize("token-1");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe("parseOAuthAllowedGroups", () => {
  it("normalizes, deduplicates, and strips boundary slashes", () => {
    expect(parseOAuthAllowedGroups("/My-Org/Engineering/,my-org/engineering,Security")).toEqual([
      "my-org/engineering",
      "security"
    ]);
  });

  it.each(["/", "my org", "my-org//team", "my-org/..", "https://gitlab.example.com/group"])(
    "rejects invalid full path %s",
    (value) => expect(() => parseOAuthAllowedGroups(value)).toThrow("GITLAB_OAUTH_ALLOWED_GROUPS")
  );
});
