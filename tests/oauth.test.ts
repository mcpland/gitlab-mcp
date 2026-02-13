import { describe, expect, it } from "vitest";

import { deriveGitLabBaseUrl } from "../src/lib/oauth.js";

describe("deriveGitLabBaseUrl", () => {
  it("extracts base URL from standard API URL", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com/api/v4")).toBe(
      "https://gitlab.example.com"
    );
  });

  it("extracts base URL from API URL with trailing slash", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com/api/v4/")).toBe(
      "https://gitlab.example.com"
    );
  });

  it("handles subpath GitLab installations", () => {
    expect(deriveGitLabBaseUrl("https://company.com/gitlab/api/v4")).toBe(
      "https://company.com/gitlab"
    );
  });

  it("handles gitlab.com", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.com/api/v4")).toBe("https://gitlab.com");
  });

  it("handles URL without /api/v4 suffix", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com/custom")).toBe(
      "https://gitlab.example.com/custom"
    );
  });

  it("handles URL with port", () => {
    expect(deriveGitLabBaseUrl("https://gitlab.example.com:8443/api/v4")).toBe(
      "https://gitlab.example.com:8443"
    );
  });

  it("handles HTTP URL", () => {
    expect(deriveGitLabBaseUrl("http://localhost:8080/api/v4")).toBe("http://localhost:8080");
  });
});
