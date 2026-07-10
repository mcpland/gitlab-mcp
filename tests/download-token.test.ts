import { describe, expect, it } from "vitest";

import {
  createDownloadToken,
  decryptDownloadToken,
  downloadTokenResourceMatches
} from "../src/lib/download-token.js";

describe("download token", () => {
  const sharedSecret = "test-download-secret-with-32-characters";

  it("round-trips auth and resource binding", () => {
    const resource = {
      type: "job-artifacts",
      params: { project_id: "group/project", job_id: "42" }
    };
    const token = createDownloadToken(
      {
        header: "authorization",
        token: "access-token",
        apiUrl: "https://gitlab.example.com/api/v4"
      },
      resource,
      { secret: sharedSecret, ttlSeconds: 300, now: 1_000_000 }
    );

    const payload = decryptDownloadToken(token, { secret: sharedSecret, now: 1_000_000 });

    expect(payload).toMatchObject({
      header: "authorization",
      token: "access-token",
      apiUrl: "https://gitlab.example.com/api/v4",
      resource
    });
    expect(payload && downloadTokenResourceMatches(payload, resource)).toBe(true);
    expect(
      payload &&
        downloadTokenResourceMatches(payload, {
          type: "job-artifacts",
          params: { project_id: "group/project", job_id: "43" }
        })
    ).toBe(false);
  });

  it("rejects expired tokens", () => {
    const token = createDownloadToken(
      { header: "private-token", token: "pat" },
      { type: "attachment", params: { project_id: "p", secret: "s", filename: "f.txt" } },
      { secret: sharedSecret, ttlSeconds: 1, now: 1_000_000 }
    );

    expect(decryptDownloadToken(token, { secret: sharedSecret, now: 1_003_000 })).toBeUndefined();
  });

  it("rejects low-entropy configured secrets", () => {
    expect(() =>
      createDownloadToken(
        { header: "private-token", token: "pat" },
        { type: "attachment", params: { project_id: "p", secret: "s", filename: "f.txt" } },
        { secret: "too-short", ttlSeconds: 300 }
      )
    ).toThrow("at least 32 characters");
  });
});
