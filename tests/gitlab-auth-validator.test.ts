import { describe, expect, it, vi } from "vitest";

import { GitLabAuthValidator } from "../src/lib/gitlab-auth-validator.js";

describe("GitLabAuthValidator", () => {
  it("validates a PAT through /user without following redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://gitlab.example.com/api/v4/user");
      expect(new Headers(init?.headers).get("private-token")).toBe("secret-pat");
      expect(init?.redirect).toBe("error");
      return new Response("{}", { status: 200 });
    });
    const validator = new GitLabAuthValidator({ ttlMs: 30_000, timeoutMs: 5_000, fetchImpl });

    await expect(
      validator.validate({
        apiUrl: "https://gitlab.example.com/api/v4",
        header: "private-token",
        token: "secret-pat"
      })
    ).resolves.toBe(true);
  });

  it("falls back from /user to /job for job tokens", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      paths.push(new URL(String(input)).pathname);
      expect(new Headers(init?.headers).get("job-token")).toBe("secret-job-token");
      return new Response("{}", { status: paths.length === 1 ? 401 : 200 });
    });
    const validator = new GitLabAuthValidator({ ttlMs: 30_000, timeoutMs: 5_000, fetchImpl });

    await expect(
      validator.validate({
        apiUrl: "https://gitlab.example.com/api/v4",
        header: "job-token",
        token: "secret-job-token"
      })
    ).resolves.toBe(true);
    expect(paths).toEqual(["/api/v4/user", "/api/v4/job"]);
  });

  it("caches positive and negative results for the short TTL", async () => {
    let now = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const valid = new Headers(init?.headers).get("private-token") === "valid-token";
      return new Response("{}", { status: valid ? 200 : 401 });
    });
    const validator = new GitLabAuthValidator({
      ttlMs: 1_000,
      timeoutMs: 5_000,
      fetchImpl,
      now: () => now
    });
    const validAuth = {
      apiUrl: "https://gitlab.example.com/api/v4",
      header: "private-token" as const,
      token: "valid-token"
    };
    const invalidAuth = { ...validAuth, token: "invalid-token" };

    await expect(validator.validate(validAuth)).resolves.toBe(true);
    await expect(validator.validate(validAuth)).resolves.toBe(true);
    await expect(validator.validate(invalidAuth)).resolves.toBe(false);
    await expect(validator.validate(invalidAuth)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now = 1_000;
    await expect(validator.validate(validAuth)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent validation for the same token digest", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const validator = new GitLabAuthValidator({ ttlMs: 30_000, timeoutMs: 5_000, fetchImpl });
    const auth = {
      apiUrl: "https://gitlab.example.com/api/v4",
      header: "authorization" as const,
      token: "oauth-or-pat-token"
    };

    const first = validator.validate(auth);
    const second = validator.validate(auth);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch?.(new Response("{}", { status: 200 }));
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});
