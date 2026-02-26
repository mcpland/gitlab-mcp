import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDotenvFromArgv, resolveEnvFilePathFromArgv } from "../src/config/dotenv.js";

describe("resolveEnvFilePathFromArgv", () => {
  it("returns undefined when --env-file is not present", () => {
    expect(resolveEnvFilePathFromArgv(["node", "dist/index.js"])).toBeUndefined();
  });

  it("reads --env-file <path>", () => {
    expect(resolveEnvFilePathFromArgv(["node", "dist/index.js", "--env-file", ".env.local"])).toBe(
      ".env.local"
    );
  });

  it("reads --env-file=<path>", () => {
    expect(resolveEnvFilePathFromArgv(["node", "dist/index.js", "--env-file=.env.local"])).toBe(
      ".env.local"
    );
  });

  it("uses the last --env-file when repeated", () => {
    expect(
      resolveEnvFilePathFromArgv([
        "node",
        "dist/index.js",
        "--env-file=.env.first",
        "--env-file",
        ".env.second"
      ])
    ).toBe(".env.second");
  });

  it("throws when --env-file is missing a value", () => {
    expect(() => resolveEnvFilePathFromArgv(["node", "dist/index.js", "--env-file"])).toThrow(
      "--env-file requires a file path"
    );
  });

  it("throws when --env-file= has an empty value", () => {
    expect(() => resolveEnvFilePathFromArgv(["node", "dist/index.js", "--env-file="])).toThrow(
      "--env-file requires a file path"
    );
  });
});

describe("loadDotenvFromArgv", () => {
  it("loads variables from the provided env file", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gitlab-mcp-env-"));

    try {
      const envFile = join(tempDir, "custom.env");
      writeFileSync(envFile, "LOG_LEVEL=debug\nUSE_PIPELINE=false\n");

      const targetEnv: NodeJS.ProcessEnv = {};
      loadDotenvFromArgv(["node", "dist/index.js", "--env-file", envFile], targetEnv);

      expect(targetEnv.LOG_LEVEL).toBe("debug");
      expect(targetEnv.USE_PIPELINE).toBe("false");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when the provided env file cannot be loaded", () => {
    const missingPath = join(tmpdir(), "gitlab-mcp-env-missing.env");
    const targetEnv: NodeJS.ProcessEnv = {};

    expect(() =>
      loadDotenvFromArgv(["node", "dist/index.js", `--env-file=${missingPath}`], targetEnv)
    ).toThrow(`Failed to load --env-file '${missingPath}'`);
  });
});
