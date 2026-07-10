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
  it("starts with the compact core toolset when no environment file is present", () => {
    expect(readEnvironmentValue("env.GITLAB_TOOLSETS")).toEqual(["core"]);
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
});
