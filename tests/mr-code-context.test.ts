import { describe, expect, it } from "vitest";

import { getMergeRequestCodeContext } from "../src/tools/mr-code-context.js";

function makeDiffFile(
  overrides: Partial<{
    old_path: string;
    new_path: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
    diff: string;
  }> = {}
) {
  return {
    old_path: overrides.old_path ?? "src/file.ts",
    new_path: overrides.new_path ?? "src/file.ts",
    new_file: overrides.new_file ?? false,
    renamed_file: overrides.renamed_file ?? false,
    deleted_file: overrides.deleted_file ?? false,
    diff: overrides.diff ?? "@@ -1,1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;"
  };
}

function createMockContext(
  files: ReturnType<typeof makeDiffFile>[],
  fileContents?: Record<string, string>
) {
  return {
    gitlab: {
      getMergeRequest: async () => ({ source_branch: "feature/a", target_branch: "main" }),
      getMergeRequestDiffs: async () => ({ changes: files }),
      getFileContents: async (_projectId: string, filePath: string) => {
        const content = fileContents?.[filePath] ?? "line1\nline2\nline3\nline4\nline5";
        return {
          file_path: filePath,
          encoding: "base64",
          content: Buffer.from(content).toString("base64")
        };
      }
    }
  } as never;
}

const defaultArgs = {
  projectId: "group/app",
  mergeRequestIid: "12",
  includePaths: undefined as string[] | undefined,
  excludePaths: undefined as string[] | undefined,
  extensions: undefined as string[] | undefined,
  languages: undefined as string[] | undefined,
  maxFiles: 30,
  maxTotalChars: 120_000,
  contextLines: 20,
  mode: "patch" as const,
  sort: "changed_lines" as const,
  listOnly: false
};

describe("getMergeRequestCodeContext", () => {
  describe("basic behavior", () => {
    it("filters files and respects budget", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/a.ts" }),
        makeDiffFile({ new_path: "docs/readme.md", diff: "@@ -1,1 +1,1 @@\n-old\n+new" })
      ]);

      const result = await getMergeRequestCodeContext(
        {
          ...defaultArgs,
          includePaths: ["src/**"],
          extensions: ["ts"],
          maxTotalChars: 10,
          mode: "fullfile",
          contextLines: 1
        },
        context
      );

      expect(result.filtered_files).toBe(1);
      expect(result.returned_files).toBe(1);

      const files = result.files as Array<Record<string, unknown>>;
      expect(files.length).toBeGreaterThan(0);
      expect(String(files[0]?.new_path)).toBe("src/a.ts");
      expect(files[0]?.truncated).toBeTruthy();
    });

    it("returns file list only when list_only is true", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/a.ts", diff: "@@ -1,1 +1,1 @@\n-a\n+b" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, listOnly: true, sort: "path", mode: "patch" },
        context
      );

      expect(result.list_only).toBeTruthy();
      expect(result.selected_files).toBe(1);
    });
  });

  describe("extractDiffFiles", () => {
    it("handles response with changes array", async () => {
      const context = {
        gitlab: {
          getMergeRequest: async () => ({ source_branch: "f", target_branch: "main" }),
          getMergeRequestDiffs: async () => ({
            changes: [makeDiffFile({ new_path: "a.ts" })]
          }),
          getFileContents: async () => ({ content: "", encoding: "text" })
        }
      } as never;

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      expect(result.total_files).toBe(1);
    });

    it("handles response with diffs array", async () => {
      const context = {
        gitlab: {
          getMergeRequest: async () => ({ source_branch: "f", target_branch: "main" }),
          getMergeRequestDiffs: async () => ({
            diffs: [makeDiffFile({ new_path: "a.ts" })]
          }),
          getFileContents: async () => ({ content: "", encoding: "text" })
        }
      } as never;

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      expect(result.total_files).toBe(1);
    });

    it("handles direct array response", async () => {
      const context = {
        gitlab: {
          getMergeRequest: async () => ({ source_branch: "f", target_branch: "main" }),
          getMergeRequestDiffs: async () => [makeDiffFile({ new_path: "a.ts" })],
          getFileContents: async () => ({ content: "", encoding: "text" })
        }
      } as never;

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      expect(result.total_files).toBe(1);
    });

    it("returns empty when response has no recognizable format", async () => {
      const context = {
        gitlab: {
          getMergeRequest: async () => ({ source_branch: "f", target_branch: "main" }),
          getMergeRequestDiffs: async () => ({ unrelated: "data" }),
          getFileContents: async () => ({ content: "", encoding: "text" })
        }
      } as never;

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      expect(result.total_files).toBe(0);
    });
  });

  describe("filtering", () => {
    it("filters by includePaths glob pattern", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/index.ts" }),
        makeDiffFile({ new_path: "tests/test.ts" }),
        makeDiffFile({ new_path: "src/utils/helper.ts" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, includePaths: ["src/**"], listOnly: true },
        context
      );

      // listOnly mode returns selected_files (after filtering + maxFiles)
      expect(result.selected_files).toBe(2);
    });

    it("filters by excludePaths glob pattern", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/index.ts" }),
        makeDiffFile({ new_path: "node_modules/pkg/index.js" }),
        makeDiffFile({ new_path: "src/utils.ts" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, excludePaths: ["node_modules/**"], listOnly: true },
        context
      );

      expect(result.selected_files).toBe(2);
    });

    it("filters by extensions", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/index.ts" }),
        makeDiffFile({ new_path: "src/style.css" }),
        makeDiffFile({ new_path: "src/app.tsx" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, extensions: [".ts", ".tsx"], listOnly: true },
        context
      );

      expect(result.selected_files).toBe(2);
    });

    it("filters by extensions without dot prefix", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/index.ts" }),
        makeDiffFile({ new_path: "src/style.css" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, extensions: ["ts"], listOnly: true },
        context
      );

      expect(result.selected_files).toBe(1);
    });

    it("filters by language", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/index.ts" }),
        makeDiffFile({ new_path: "src/app.tsx" }),
        makeDiffFile({ new_path: "src/main.py" }),
        makeDiffFile({ new_path: "src/style.css" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, languages: ["typescript"], listOnly: true },
        context
      );

      expect(result.selected_files).toBe(2);
    });

    it("combines include, exclude, and extensions filters", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "src/index.ts" }),
        makeDiffFile({ new_path: "src/test.spec.ts" }),
        makeDiffFile({ new_path: "docs/readme.md" })
      ]);

      const result = await getMergeRequestCodeContext(
        {
          ...defaultArgs,
          includePaths: ["src/**"],
          excludePaths: ["**/*.spec.ts"],
          extensions: [".ts"],
          listOnly: true
        },
        context
      );

      expect(result.selected_files).toBe(1);
    });

    it("handles no filters (returns all files)", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "a.ts" }),
        makeDiffFile({ new_path: "b.css" }),
        makeDiffFile({ new_path: "c.md" })
      ]);

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      expect(result.total_files).toBe(3);
      expect(result.selected_files).toBe(3);
    });
  });

  describe("sorting", () => {
    it("sorts by changed_lines descending", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "small.ts", diff: "@@ -1 +1 @@\n+a" }),
        makeDiffFile({ new_path: "big.ts", diff: "@@ -1 +1,4 @@\n+a\n+b\n+c\n+d" }),
        makeDiffFile({ new_path: "medium.ts", diff: "@@ -1 +1,2 @@\n+a\n+b" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, sort: "changed_lines", listOnly: true },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.new_path).toBe("big.ts");
      expect(files[1]?.new_path).toBe("medium.ts");
      expect(files[2]?.new_path).toBe("small.ts");
    });

    it("sorts by path alphabetically", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "z.ts" }),
        makeDiffFile({ new_path: "a.ts" }),
        makeDiffFile({ new_path: "m.ts" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, sort: "path", listOnly: true },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.new_path).toBe("a.ts");
      expect(files[1]?.new_path).toBe("m.ts");
      expect(files[2]?.new_path).toBe("z.ts");
    });

    it("sorts by file_size (diff length) descending", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "short.ts", diff: "short" }),
        makeDiffFile({ new_path: "long.ts", diff: "a".repeat(100) }),
        makeDiffFile({ new_path: "medium.ts", diff: "a".repeat(50) })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, sort: "file_size", listOnly: true },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.new_path).toBe("long.ts");
      expect(files[1]?.new_path).toBe("medium.ts");
      expect(files[2]?.new_path).toBe("short.ts");
    });
  });

  describe("modes", () => {
    it("returns patch content in patch mode", async () => {
      const diff = "@@ -1,1 +1,2 @@\n-old\n+new\n+added";
      const context = createMockContext([makeDiffFile({ new_path: "a.ts", diff })]);

      const result = await getMergeRequestCodeContext({ ...defaultArgs, mode: "patch" }, context);

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.content_mode).toBe("patch");
      expect(String(files[0]?.content)).toContain("+new");
    });

    it("returns full file content in fullfile mode", async () => {
      const context = createMockContext([makeDiffFile({ new_path: "a.ts" })], {
        "a.ts": "const x = 1;\nconst y = 2;\nconst z = 3;"
      });

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, mode: "fullfile" },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.content_mode).toBe("fullfile");
      expect(String(files[0]?.content)).toContain("const x = 1;");
    });

    it("returns surrounding snippets in surrounding mode", async () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const diff = "@@ -10,1 +10,2 @@\n-old line 10\n+new line 10\n+extra";

      const context = createMockContext([makeDiffFile({ new_path: "a.ts", diff })], {
        "a.ts": lines
      });

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, mode: "surrounding", contextLines: 3 },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.content_mode).toBe("surrounding");
      expect(files[0]?.snippet_windows).toBeDefined();
    });

    it("uses patch mode for deleted files even in fullfile mode", async () => {
      const diff = "@@ -1,2 +0,0 @@\n-line1\n-line2";
      const context = createMockContext([
        makeDiffFile({ new_path: "deleted.ts", deleted_file: true, diff })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, mode: "fullfile" },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.content_mode).toBe("patch");
    });
  });

  describe("budget management", () => {
    it("reports budget usage in response", async () => {
      const context = createMockContext([makeDiffFile({ new_path: "a.ts" })]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, maxTotalChars: 5000 },
        context
      );

      const budget = result.budget as Record<string, number>;
      expect(budget.max_total_chars).toBe(5000);
      expect(budget.used_chars).toBeGreaterThan(0);
      expect(budget.remaining_chars).toBeDefined();
    });

    it("truncates content when budget is exceeded", async () => {
      const context = createMockContext([
        makeDiffFile({
          new_path: "a.ts",
          diff: "x".repeat(100)
        })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, maxTotalChars: 10 },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.truncated).toBe(true);
    });

    it("respects maxFiles limit", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "a.ts" }),
        makeDiffFile({ new_path: "b.ts" }),
        makeDiffFile({ new_path: "c.ts" }),
        makeDiffFile({ new_path: "d.ts" }),
        makeDiffFile({ new_path: "e.ts" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, maxFiles: 2, listOnly: true },
        context
      );

      expect(result.total_files).toBe(5);
      expect(result.selected_files).toBe(2);
    });

    it("stops processing files when budget is exhausted", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "a.ts", diff: "a".repeat(100) }),
        makeDiffFile({ new_path: "b.ts", diff: "b".repeat(100) }),
        makeDiffFile({ new_path: "c.ts", diff: "c".repeat(100) })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, maxTotalChars: 50 },
        context
      );

      const files = result.files as Array<Record<string, unknown>>;
      // Should stop after budget is exhausted
      expect(files.length).toBeLessThanOrEqual(2);
    });
  });

  describe("changed lines counting", () => {
    it("counts added and removed lines", async () => {
      const diff = "@@ -1,3 +1,4 @@\n context\n-removed1\n-removed2\n+added1\n+added2\n+added3";
      const context = createMockContext([makeDiffFile({ new_path: "a.ts", diff })]);

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.changed_lines).toBe(5); // 2 removed + 3 added
    });

    it("ignores --- and +++ header lines", async () => {
      const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new";
      const context = createMockContext([makeDiffFile({ new_path: "a.ts", diff })]);

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.changed_lines).toBe(2); // Only -old and +new
    });

    it("counts zero for empty diff", async () => {
      const context = createMockContext([makeDiffFile({ new_path: "a.ts", diff: "" })]);

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]?.changed_lines).toBe(0);
    });
  });

  describe("response structure", () => {
    it("includes all expected fields in response", async () => {
      const context = createMockContext([makeDiffFile({ new_path: "a.ts" })]);

      const result = await getMergeRequestCodeContext({ ...defaultArgs }, context);

      expect(result).toHaveProperty("project_id");
      expect(result).toHaveProperty("merge_request_iid");
      expect(result).toHaveProperty("source_branch");
      expect(result).toHaveProperty("target_branch");
      expect(result).toHaveProperty("mode");
      expect(result).toHaveProperty("total_files");
      expect(result).toHaveProperty("filtered_files");
      expect(result).toHaveProperty("selected_files");
      expect(result).toHaveProperty("returned_files");
      expect(result).toHaveProperty("budget");
      expect(result).toHaveProperty("files");
    });

    it("includes file summary fields", async () => {
      const context = createMockContext([
        makeDiffFile({
          new_path: "new.ts",
          old_path: "old.ts",
          new_file: true,
          renamed_file: true
        })
      ]);

      const result = await getMergeRequestCodeContext({ ...defaultArgs, listOnly: true }, context);

      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0]).toHaveProperty("old_path");
      expect(files[0]).toHaveProperty("new_path");
      expect(files[0]).toHaveProperty("new_file");
      expect(files[0]).toHaveProperty("renamed_file");
      expect(files[0]).toHaveProperty("deleted_file");
      expect(files[0]).toHaveProperty("changed_lines");
    });

    it("uses source_branch as ref for file content", async () => {
      const context = {
        gitlab: {
          getMergeRequest: async () => ({ source_branch: "my-feature", target_branch: "develop" }),
          getMergeRequestDiffs: async () => ({
            changes: [makeDiffFile({ new_path: "a.ts" })]
          }),
          getFileContents: async (_projId: string, _path: string, ref: string) => {
            expect(ref).toBe("my-feature");
            return { content: Buffer.from("content").toString("base64"), encoding: "base64" };
          }
        }
      } as never;

      await getMergeRequestCodeContext({ ...defaultArgs, mode: "fullfile" }, context);
    });
  });

  describe("language mappings", () => {
    it("maps python to .py extension", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "main.py" }),
        makeDiffFile({ new_path: "main.ts" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, languages: ["python"], listOnly: true },
        context
      );

      expect(result.selected_files).toBe(1);
    });

    it("maps javascript to multiple extensions", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "a.js" }),
        makeDiffFile({ new_path: "b.jsx" }),
        makeDiffFile({ new_path: "c.mjs" }),
        makeDiffFile({ new_path: "d.ts" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, languages: ["javascript"], listOnly: true },
        context
      );

      expect(result.selected_files).toBe(3);
    });

    it("handles unknown language gracefully (no filtering when language map returns empty)", async () => {
      const context = createMockContext([
        makeDiffFile({ new_path: "a.ts" }),
        makeDiffFile({ new_path: "b.py" })
      ]);

      const result = await getMergeRequestCodeContext(
        { ...defaultArgs, languages: ["nonexistent"], listOnly: true },
        context
      );

      // When language is unknown, languageToExtensions returns [],
      // languageExtSet is empty, so the filter is effectively a no-op
      // and all files pass through.
      expect(result.selected_files).toBe(2);
    });
  });
});
