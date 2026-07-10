import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

describe("environment defaults", () => {
  it("starts with the compact core toolset when no environment file is present", () => {
    const tempDirectory = mkdtempSync(path.join(tmpdir(), "gitlab-mcp-defaults-"));
    const emptyEnvFile = path.join(tempDirectory, "empty.env");
    writeFileSync(emptyEnvFile, "");

    try {
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          "const { env } = await import('./src/config/env.ts'); process.stdout.write(JSON.stringify(env.GITLAB_TOOLSETS));",
          "gitlab-mcp-env-test",
          `--env-file=${emptyEnvFile}`
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

      expect(JSON.parse(output)).toEqual(["core"]);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
