/**
 * Project snippet tools.
 */
import { describe, expect, it, vi } from "vitest";

import { extractSnippetRef } from "../../src/tools/snippets.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("extractSnippetRef", () => {
  it("reads the revision between the raw marker and the file path", () => {
    expect(
      extractSnippetRef(
        "https://gitlab.example.com/group/project/-/snippets/7/raw/main/src/raw/app.rb",
        "7",
        "src/raw/app.rb"
      )
    ).toBe("main");
    expect(
      extractSnippetRef(
        "https://gitlab.example.com/group/project/-/snippets/7/raw/feature/x/notes%20v2.md",
        "7",
        "notes v2.md"
      )
    ).toBe("feature/x");
    expect(
      extractSnippetRef("https://gitlab.example.com/-/snippets/8/raw/main/a.rb", "7", "a.rb")
    ).toBeUndefined();
    expect(extractSnippetRef("not a url", "7", "a.rb")).toBeUndefined();
  });
});

describe("project snippet tools", () => {
  it("returns metadata and optionally each file's raw content", async () => {
    const snippet = {
      id: 7,
      title: "Helpers",
      files: [
        {
          path: "src/app.rb",
          raw_url: "https://gitlab.example.com/group/project/-/snippets/7/raw/main/src/app.rb"
        },
        {
          path: "README.md",
          raw_url: "https://gitlab.example.com/group/project/-/snippets/7/raw/main/README.md"
        }
      ]
    };
    const get = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/projects/group%2Fproject/snippets/7") {
        return snippet;
      }
      return `content of ${path}`;
    });
    const context = buildContext({ gitlabStub: { get } });

    const metadata = parseToolText(
      await callToolWithContext(context, "gitlab_get_project_snippet", {
        project_id: "group/project",
        snippet_id: 7
      })
    );
    const withContent = parseToolText(
      await callToolWithContext(context, "gitlab_get_project_snippet", {
        project_id: "group/project",
        snippet_id: "7",
        include_content: true
      })
    ) as { files: Array<{ path: string; content: string }> };

    expect(metadata).toEqual(snippet);
    expect(withContent.files.map((file) => file.content)).toEqual([
      "content of /projects/group%2Fproject/snippets/7/files/main/src%2Fapp.rb/raw",
      "content of /projects/group%2Fproject/snippets/7/files/main/README.md/raw"
    ]);
  });

  it("falls back to the single-file raw endpoint when files are not listed", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: 8, file_name: "legacy.txt" })
      .mockResolvedValueOnce("legacy content");

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { get } }),
        "gitlab_get_project_snippet",
        {
          project_id: "group/project",
          snippet_id: "8",
          include_content: true
        }
      )
    ) as { files: unknown[] };

    expect(get).toHaveBeenLastCalledWith("/projects/group%2Fproject/snippets/8/raw");
    expect(result.files).toEqual([{ path: "legacy.txt", content: "legacy content" }]);
  });

  it("creates, updates, lists, and deletes snippets", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const post = vi.fn().mockResolvedValue({ id: 9 });
    const put = vi.fn().mockResolvedValue({ id: 9 });
    const del = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { get, post, put, delete: del } });

    await callToolWithContext(context, "gitlab_list_project_snippets", {
      project_id: "group/project",
      per_page: 5
    });
    await callToolWithContext(context, "gitlab_create_project_snippet", {
      project_id: "group/project",
      title: "Helpers",
      visibility: "private",
      files: [{ file_path: "a.rb", content: "puts 1" }]
    });
    await callToolWithContext(context, "gitlab_update_project_snippet", {
      project_id: "group/project",
      snippet_id: "9",
      files: [{ action: "move", previous_path: "a.rb", file_path: "b.rb" }]
    });
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_project_snippet", {
        project_id: "group/project",
        snippet_id: "9"
      })
    );

    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/snippets", {
      query: { per_page: 5 }
    });
    expect(post).toHaveBeenCalledWith("/projects/group%2Fproject/snippets", {
      body: JSON.stringify({
        title: "Helpers",
        visibility: "private",
        files: [{ file_path: "a.rb", content: "puts 1" }]
      }),
      headers: JSON_HEADERS
    });
    expect(put).toHaveBeenCalledWith("/projects/group%2Fproject/snippets/9", {
      body: JSON.stringify({
        files: [{ action: "move", file_path: "b.rb", previous_path: "a.rb" }]
      }),
      headers: JSON_HEADERS
    });
    expect(deleted).toEqual({ status: "deleted", project_id: "group/project", snippet_id: "9" });
  });

  it("validates file actions and paths before calling GitLab", async () => {
    const put = vi.fn();
    const post = vi.fn();
    const context = buildContext({ gitlabStub: { put, post } });

    for (const files of [
      [{ action: "move", file_path: "b.rb" }],
      [{ action: "update", file_path: "b.rb" }],
      [{ action: "create", file_path: "../escape.rb", content: "x" }]
    ]) {
      const result = await callToolWithContext(context, "gitlab_update_project_snippet", {
        project_id: "group/project",
        snippet_id: "9",
        files
      });
      expect(result.isError, JSON.stringify(files)).toBe(true);
    }
    const noFiles = await callToolWithContext(context, "gitlab_create_project_snippet", {
      project_id: "group/project",
      title: "Empty",
      files: []
    });

    expect(noFiles.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
