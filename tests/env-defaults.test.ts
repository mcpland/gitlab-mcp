import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

function readEnvironmentValue(expression: string, envFileContents = ""): unknown {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "gitlab-mcp-defaults-"));
  const envFile = path.join(tempDirectory, "test.env");
  writeFileSync(envFile, envFileContents);

  try {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const { env } = await import('./src/config/env.ts'); process.stdout.write(JSON.stringify(${expression}));`,
        "gitlab-mcp-env-test",
        `--env-file=${envFile}`
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          HOME: process.env.HOME,
          NODE_ENV: "test",
          PATH: process.env.PATH
        }
      }
    );

    return JSON.parse(output) as unknown;
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

describe("environment defaults", () => {
  it("exposes all toolsets when no environment file is present", () => {
    expect(readEnvironmentValue("env.GITLAB_TOOLSETS")).toEqual(["all"]);
  });

  it("defaults permission mode to full", () => {
    expect(readEnvironmentValue("env.GITLAB_PERMISSION_MODE")).toBe("full");
  });

  it("accepts modify permission mode", () => {
    expect(
      readEnvironmentValue("env.GITLAB_PERMISSION_MODE", "GITLAB_PERMISSION_MODE=modify\n")
    ).toBe("modify");
  });

  it("gives legacy read-only mode precedence over permission mode", () => {
    expect(
      readEnvironmentValue(
        "env.GITLAB_PERMISSION_MODE",
        "GITLAB_PERMISSION_MODE=modify\nGITLAB_READ_ONLY_MODE=true\n"
      )
    ).toBe("readonly");
  });

  it("requires shared download secrets to contain at least 32 characters", () => {
    expect(() =>
      readEnvironmentValue(
        "env.GITLAB_DOWNLOAD_TOKEN_SECRET",
        "GITLAB_DOWNLOAD_TOKEN_SECRET=too-short\n"
      )
    ).toThrow();

    expect(
      readEnvironmentValue(
        "env.GITLAB_DOWNLOAD_TOKEN_SECRET",
        `GITLAB_DOWNLOAD_TOKEN_SECRET=${"d".repeat(32)}\n`
      )
    ).toBe("d".repeat(32));
  });

  it("rejects GITLAB_API_URL credentials without echoing them", () => {
    const secret = "glpat-super-secret-value";
    let message = "";
    try {
      readEnvironmentValue(
        "env.GITLAB_API_URL",
        `GITLAB_API_URL=https://gitlab.example.com,https://oauth2:${secret}@gitlab.internal.example.com\n`
      );
    } catch (error) {
      message = `${(error as Error).message}\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
    }

    expect(message).toContain(
      "GITLAB_API_URL entry #2 (https://gitlab.internal.example.com) must not include credentials"
    );
    expect(message).not.toContain(secret);
  });

  it("reports unparsable GITLAB_API_URL entries without echoing them", () => {
    const secret = "not-a-url-secret";
    let message = "";
    try {
      readEnvironmentValue("env.GITLAB_API_URL", `GITLAB_API_URL=${secret}\n`);
    } catch (error) {
      message = `${(error as Error).message}\n${String((error as { stderr?: unknown }).stderr ?? "")}`;
    }

    expect(message).toContain("Invalid GITLAB_API_URL entry #1");
    expect(message).not.toContain(secret);
  });

  it("rejects combining remote authorization with MCP OAuth", () => {
    expect(() =>
      readEnvironmentValue(
        "env.GITLAB_MCP_OAUTH",
        [
          "REMOTE_AUTHORIZATION=true",
          "GITLAB_MCP_OAUTH=true",
          "MCP_SERVER_URL=https://mcp.example.com",
          "GITLAB_OAUTH_APP_ID=test-app",
          `GITLAB_MCP_OAUTH_STATE_SECRET=${Buffer.alloc(32, 7).toString("base64url")}`
        ].join("\n")
      )
    ).toThrow("REMOTE_AUTHORIZATION=true cannot be combined with GITLAB_MCP_OAUTH=true");
  });
});
