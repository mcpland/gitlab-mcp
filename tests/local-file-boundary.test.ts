import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalFileBoundary } from "../src/lib/local-file-boundary.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("LocalFileBoundary", () => {
  it("allows reads and writes within a configured root", async () => {
    const root = await createTempDirectory("gitlab-local-root-");
    const file = path.join(root, "input.md");
    await fs.writeFile(file, "hello", "utf8");
    const boundary = new LocalFileBoundary([root]);

    await expect(boundary.resolveReadableFile(file)).resolves.toBe(await fs.realpath(file));
    const output = await boundary.resolveWritableDirectory(path.join(root, "nested/output"));
    expect(output).toBe(await fs.realpath(path.join(root, "nested/output")));
  });

  it("rejects traversal and absolute paths outside configured roots", async () => {
    const parent = await createTempDirectory("gitlab-local-parent-");
    const root = path.join(parent, "allowed");
    await fs.mkdir(root);
    const outside = path.join(parent, "outside.txt");
    await fs.writeFile(outside, "no", "utf8");
    const boundary = new LocalFileBoundary([root]);

    await expect(
      boundary.resolveReadableFile(path.join(root, "..", "outside.txt"))
    ).rejects.toThrow(/outside GITLAB_LOCAL_FILE_ROOTS/u);
    await expect(boundary.resolveWritableDirectory(path.join(parent, "output"))).rejects.toThrow(
      /outside GITLAB_LOCAL_FILE_ROOTS/u
    );
  });

  it("rejects read and write escapes through symbolic links", async () => {
    const parent = await createTempDirectory("gitlab-local-symlink-");
    const root = path.join(parent, "allowed");
    const outside = path.join(parent, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    await fs.symlink(outside, path.join(root, "escape"), "dir");
    const boundary = new LocalFileBoundary([root]);

    await expect(
      boundary.resolveReadableFile(path.join(root, "escape", "secret.md"))
    ).rejects.toThrow(/outside GITLAB_LOCAL_FILE_ROOTS/u);
    await expect(
      boundary.resolveWritableDirectory(path.join(root, "escape", "downloads"))
    ).rejects.toThrow(/outside GITLAB_LOCAL_FILE_ROOTS/u);
  });

  it("defaults to the current working directory", async () => {
    const boundary = new LocalFileBoundary();
    const inside = path.join(process.cwd(), "package.json");
    const outside = await createTempDirectory("gitlab-local-default-outside-");

    await expect(boundary.resolveReadableFile(inside)).resolves.toBe(await fs.realpath(inside));
    await expect(boundary.resolveWritableDirectory(outside)).rejects.toThrow(
      /outside GITLAB_LOCAL_FILE_ROOTS/u
    );
  });
});

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}
