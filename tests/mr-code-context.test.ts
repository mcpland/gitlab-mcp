import { describe, expect, it } from "vitest";

import { getMergeRequestCodeContext } from "../src/tools/mr-code-context.js";

describe("getMergeRequestCodeContext", () => {
  it("filters files and respects budget", async () => {
    const gitlab = {
      getMergeRequest: async () => ({ source_branch: "feature/a", target_branch: "main" }),
      getMergeRequestDiffs: async () => ({
        changes: [
          {
            old_path: "src/a.ts",
            new_path: "src/a.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: "@@ -1,1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;"
          },
          {
            old_path: "docs/readme.md",
            new_path: "docs/readme.md",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: "@@ -1,1 +1,1 @@\n-old\n+new"
          }
        ]
      }),
      getFileContents: async (_projectId: string, filePath: string) => ({
        file_path: filePath,
        encoding: "base64",
        content: Buffer.from("line1\nline2\nline3\nline4").toString("base64")
      })
    };

    const context = {
      gitlab
    } as never;

    const result = await getMergeRequestCodeContext(
      {
        projectId: "group/app",
        mergeRequestIid: "12",
        includePaths: ["src/**"],
        excludePaths: [],
        extensions: ["ts"],
        languages: [],
        maxFiles: 10,
        maxTotalChars: 10,
        contextLines: 1,
        mode: "fullfile",
        sort: "changed_lines",
        listOnly: false
      },
      context
    );

    expect(result.filtered_files).toBe(1);
    expect(result.returned_files).toBe(1);

    const files = result.files as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);
    const firstFile = files[0];
    if (!firstFile) {
      throw new Error("Expected one file in response");
    }

    expect(String(firstFile.new_path)).toBe("src/a.ts");
    expect(firstFile.truncated).toBeTruthy();
  });

  it("returns file list only when list_only is true", async () => {
    const gitlab = {
      getMergeRequest: async () => ({ source_branch: "feature/b", target_branch: "main" }),
      getMergeRequestDiffs: async () => ({
        changes: [
          {
            old_path: "src/a.ts",
            new_path: "src/a.ts",
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: "@@ -1,1 +1,1 @@\n-a\n+b"
          }
        ]
      }),
      getFileContents: async () => {
        throw new Error("should not be called for list_only");
      }
    };

    const context = {
      gitlab
    } as never;

    const result = await getMergeRequestCodeContext(
      {
        projectId: "group/app",
        mergeRequestIid: "34",
        includePaths: [],
        excludePaths: [],
        extensions: [],
        languages: [],
        maxFiles: 10,
        maxTotalChars: 1000,
        contextLines: 1,
        mode: "patch",
        sort: "path",
        listOnly: true
      },
      context
    );

    expect(result.list_only).toBeTruthy();
    expect(result.selected_files).toBe(1);
  });
});
