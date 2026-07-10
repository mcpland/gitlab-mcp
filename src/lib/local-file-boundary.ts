import * as fs from "node:fs/promises";
import * as path from "node:path";

export class LocalFileBoundary {
  private readonly roots: string[];

  constructor(configuredRoots: readonly string[] = []) {
    const roots = configuredRoots.length > 0 ? configuredRoots : [process.cwd()];
    this.roots = [...new Set(roots.map((root) => path.resolve(root)))].sort(
      (left, right) => right.length - left.length
    );
  }

  async resolveReadableFile(filePath: string): Promise<string> {
    const candidate = path.resolve(filePath);
    const root = this.findLexicalRoot(candidate);
    if (!root) {
      throw this.outsideRootsError(candidate);
    }

    const [canonicalRoot, canonicalCandidate] = await Promise.all([
      this.resolveRoot(root),
      fs.realpath(candidate)
    ]);
    if (!isPathInside(canonicalRoot, canonicalCandidate)) {
      throw this.outsideRootsError(candidate);
    }

    const stat = await fs.stat(canonicalCandidate);
    if (!stat.isFile()) {
      throw new Error(`Local file path is not a regular file: '${filePath}'`);
    }
    return canonicalCandidate;
  }

  async resolveWritableDirectory(directoryPath?: string): Promise<string> {
    const candidate = path.resolve(directoryPath ?? process.cwd());
    const root = this.findLexicalRoot(candidate);
    if (!root) {
      throw this.outsideRootsError(candidate);
    }

    const canonicalRoot = await this.resolveRoot(root);
    const existingAncestor = await findExistingAncestor(candidate);
    const canonicalAncestor = await fs.realpath(existingAncestor);
    if (!isPathInside(canonicalRoot, canonicalAncestor)) {
      throw this.outsideRootsError(candidate);
    }

    await fs.mkdir(candidate, { recursive: true });
    const canonicalCandidate = await fs.realpath(candidate);
    if (!isPathInside(canonicalRoot, canonicalCandidate)) {
      throw this.outsideRootsError(candidate);
    }

    const stat = await fs.stat(canonicalCandidate);
    if (!stat.isDirectory()) {
      throw new Error(`Local output path is not a directory: '${directoryPath ?? candidate}'`);
    }
    return canonicalCandidate;
  }

  private findLexicalRoot(candidate: string): string | undefined {
    return this.roots.find((root) => isPathInside(root, candidate));
  }

  private async resolveRoot(root: string): Promise<string> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.realpath(root);
    } catch {
      throw new Error(
        `Configured GITLAB_LOCAL_FILE_ROOTS entry does not exist or is inaccessible: '${root}'`
      );
    }

    const stat = await fs.stat(canonicalRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Configured GITLAB_LOCAL_FILE_ROOTS entry is not a directory: '${root}'`);
    }
    return canonicalRoot;
  }

  private outsideRootsError(candidate: string): Error {
    return new Error(
      `Local path '${candidate}' is outside GITLAB_LOCAL_FILE_ROOTS (${this.roots.join(", ")})`
    );
  }
}

async function findExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve an existing ancestor for local path '${candidate}'`);
    }
    current = parent;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
