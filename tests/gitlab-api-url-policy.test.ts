import { describe, expect, it } from "vitest";

import { buildGitLabApiUrlPolicy } from "../src/lib/gitlab-api-url-policy.js";

describe("GitLab API URL policy", () => {
  it("uses a request URL only as a canonical host:port selector", () => {
    const policy = buildGitLabApiUrlPolicy({
      GITLAB_API_URLS: ["https://gitlab.example.com/custom/api/v4"],
      GITLAB_POOL_MAX_SIZE: 100
    });

    expect(policy.resolve("http://gitlab.example.com:443/untrusted/path?ignored=true")).toBe(
      "https://gitlab.example.com/custom/api/v4"
    );
  });

  it("requires an exact canonical port match", () => {
    const policy = buildGitLabApiUrlPolicy({
      GITLAB_API_URLS: ["https://gitlab.example.com:8443/api/v4"],
      GITLAB_POOL_MAX_SIZE: 100
    });

    expect(policy.resolve("https://gitlab.example.com:8443/anything")).toBe(
      "https://gitlab.example.com:8443/api/v4"
    );
    expect(() => policy.resolve("https://gitlab.example.com/api/v4")).toThrow("not allowed");
  });

  it("canonicalizes additional bare hosts to HTTPS /api/v4", () => {
    const policy = buildGitLabApiUrlPolicy({
      GITLAB_API_URLS: ["https://gitlab.com/api/v4"],
      GITLAB_ALLOWED_HOSTS: ["gitlab.company.com:8443"],
      GITLAB_POOL_MAX_SIZE: 100
    });

    expect(policy.resolve("https://gitlab.company.com:8443/other/path")).toBe(
      "https://gitlab.company.com:8443/api/v4"
    );
  });

  it("rejects URL credentials and unlisted hosts", () => {
    expect(() =>
      buildGitLabApiUrlPolicy({
        GITLAB_API_URLS: ["https://user:password@gitlab.example.com/api/v4"],
        GITLAB_POOL_MAX_SIZE: 100
      })
    ).toThrow("must not include URL credentials");

    const policy = buildGitLabApiUrlPolicy({
      GITLAB_API_URLS: ["https://gitlab.example.com/api/v4"],
      GITLAB_POOL_MAX_SIZE: 100
    });
    expect(() => policy.resolve("https://attacker.example.com/api/v4")).toThrow("not allowed");
  });

  it("bounds the configured origin pool", () => {
    expect(() =>
      buildGitLabApiUrlPolicy({
        GITLAB_API_URLS: ["https://one.example.com", "https://two.example.com"],
        GITLAB_POOL_MAX_SIZE: 1
      })
    ).toThrow("exceeds GITLAB_POOL_MAX_SIZE");
  });
});
