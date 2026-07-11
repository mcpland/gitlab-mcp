import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

describe("HTTP server startup", () => {
  it("rejects an IPv6 loopback plain HTTP OAuth issuer before SDK route setup", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/http.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        HTTP_HOST: "::1",
        MCP_SERVER_URL: "http://[::1]:3333",
        GITLAB_MCP_OAUTH: "true",
        GITLAB_OAUTH_APP_ID: "test-app",
        GITLAB_MCP_OAUTH_STATE_SECRET: Buffer.alloc(32, 1).toString("base64url")
      }
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "requires an HTTPS MCP_SERVER_URL unless the issuer hostname is localhost or 127.0.0.1"
    );
    expect(result.stderr).not.toContain("Issuer URL must be HTTPS");
  });
});
