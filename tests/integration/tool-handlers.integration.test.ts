/**
 * Integration tests for individual tool handlers.
 *
 * Each test calls a tool through the full MCP protocol (client.callTool)
 * with a mocked GitLabClient, then verifies:
 *   - The correct client method was invoked with expected arguments
 *   - The response structure (content + structuredContent) is correct
 */
import { describe, expect, it, vi } from "vitest";

import { runWithSessionAuth } from "../../src/lib/auth-context.js";
import { GitLabApiError } from "../../src/lib/gitlab-client.js";
import { attachPaginationMetadata } from "../../src/lib/pagination.js";
import { buildContext, createLinkedPair } from "./_helpers.js";

/* ------------------------------------------------------------------ */
/*  gitlab_get_project                                                 */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_get_project", () => {
  it("passes project_id to context.gitlab.getProject()", async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 42,
      name: "my-project",
      path_with_namespace: "group/my-project"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/my-project" }
      });

      expect(result.isError).toBeFalsy();
      expect(getProject).toHaveBeenCalledWith("group/my-project");

      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("my-project");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_get_pipeline_job_output                                     */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_get_pipeline_job_output", () => {
  it("passes bounded line window options to the client", async () => {
    const getPipelineJobOutput = vi
      .fn()
      .mockResolvedValue(
        "[Untrusted CI job trace: logs can contain attacker-controlled text.]\n\nlast line"
      );
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getPipelineJobOutput } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_pipeline_job_output",
        arguments: {
          project_id: "group/project",
          job_id: "77",
          limit: 250,
          offset: 10
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getPipelineJobOutput).toHaveBeenCalledWith("group/project", "77", {
        limit: 250,
        offset: 10
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_list_projects                                               */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_list_projects", () => {
  it("passes query params via toQuery()", async () => {
    const listProjects = vi.fn().mockResolvedValue([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" }
    ]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listProjects } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: { search: "test", topic: "platform", page: 2, per_page: 10 }
      });

      expect(result.isError).toBeFalsy();
      expect(listProjects).toHaveBeenCalledWith({
        query: expect.objectContaining({
          search: "test",
          topic: "platform",
          page: 2,
          per_page: 10
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_update_project                                              */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_update_project", () => {
  it("passes only the explicit allowlisted project fields", async () => {
    const updatedProject = {
      id: 42,
      name: "Renamed project",
      visibility: "internal",
      issues_access_level: "private"
    };
    const updateProject = vi.fn().mockResolvedValue(updatedProject);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { updateProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_update_project",
        arguments: {
          project_id: "group/project",
          name: "Renamed project",
          visibility: "internal",
          topics: ["mcp", "gitlab"],
          request_access_enabled: false,
          only_allow_merge_if_pipeline_succeeds: true,
          merge_method: "ff",
          issues_access_level: "private",
          pages_access_level: "public"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(updateProject).toHaveBeenCalledWith("group/project", {
        name: "Renamed project",
        visibility: "internal",
        topics: ["mcp", "gitlab"],
        request_access_enabled: false,
        only_allow_merge_if_pipeline_succeeds: true,
        merge_method: "ff",
        issues_access_level: "private",
        pages_access_level: "public"
      });
      expect(result.structuredContent).toMatchObject({ result: updatedProject });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects empty and non-allowlisted project updates before the API call", async () => {
    const updateProject = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { updateProject } })
    );

    try {
      const empty = await client.callTool({
        name: "gitlab_update_project",
        arguments: { project_id: "group/project" }
      });
      const unsafe = await client.callTool({
        name: "gitlab_update_project",
        arguments: {
          project_id: "group/project",
          import_url: "https://user:secret@example.com/repository.git"
        }
      });

      expect(empty.isError).toBe(true);
      expect(unsafe.isError).toBe(true);
      expect(updateProject).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects project updates outside the configured project scope", async () => {
    const updateProject = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/allowed"],
        gitlabStub: { updateProject }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_update_project",
        arguments: { project_id: "group/forbidden", description: "blocked" }
      });

      expect(result.isError).toBe(true);
      expect(updateProject).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_list_group_projects                                         */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_list_group_projects", () => {
  it("passes group_id and topic filter via toQuery()", async () => {
    const listGroupProjects = vi.fn().mockResolvedValue([{ id: 1, name: "alpha" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listGroupProjects } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_group_projects",
        arguments: {
          group_id: "group/subgroup",
          include_subgroups: true,
          search: "test",
          topic: "platform",
          per_page: 20
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listGroupProjects).toHaveBeenCalledWith("group/subgroup", {
        query: expect.objectContaining({
          include_subgroups: true,
          search: "test",
          topic: "platform",
          per_page: 20
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_create_group                                                */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_create_group", () => {
  it("passes payload to createGroup", async () => {
    const createGroup = vi.fn().mockResolvedValue({ id: 1, name: "Team" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createGroup } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_group",
        arguments: {
          name: "Team",
          path: "team",
          description: "Team group",
          visibility: "private",
          parent_id: 42
        }
      });

      expect(result.isError).toBeFalsy();
      expect(createGroup).toHaveBeenCalledWith({
        name: "Team",
        path: "team",
        description: "Team group",
        visibility: "private",
        parent_id: 42
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Code search tools                                                  */
/* ------------------------------------------------------------------ */

describe("Tool handlers: code search tools", () => {
  it("passes filters to gitlab_search_code", async () => {
    const searchCode = vi.fn().mockResolvedValue([{ path: "src/index.ts" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { searchCode } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_search_code",
        arguments: {
          search: "logger",
          filename: "*.ts",
          extension: "ts",
          page: 2
        }
      });

      expect(result.isError).toBeFalsy();
      expect(searchCode).toHaveBeenCalledWith("logger", {
        query: expect.objectContaining({
          filename: "*.ts",
          extension: "ts",
          page: 2
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes filters to gitlab_search_project_code", async () => {
    const searchCodeBlobs = vi.fn().mockResolvedValue([{ path: "src/index.ts" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { searchCodeBlobs } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_search_project_code",
        arguments: {
          project_id: "group/project",
          search: "logger",
          ref: "main",
          path: "src/*",
          per_page: 5
        }
      });

      expect(result.isError).toBeFalsy();
      expect(searchCodeBlobs).toHaveBeenCalledWith("group/project", "logger", {
        query: expect.objectContaining({
          ref: "main",
          path: "src/*",
          per_page: 5
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes filters to gitlab_search_group_code", async () => {
    const searchGroupCodeBlobs = vi.fn().mockResolvedValue([{ path: "src/index.ts" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { searchGroupCodeBlobs } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_search_group_code",
        arguments: {
          group_id: "parent/group",
          search: "logger",
          filename: "*.ts",
          page: 2
        }
      });

      expect(result.isError).toBeFalsy();
      expect(searchGroupCodeBlobs).toHaveBeenCalledWith("parent/group", "logger", {
        query: expect.objectContaining({
          filename: "*.ts",
          page: 2
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_get_file_contents                                           */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_get_file_contents", () => {
  it("passes project_id, file_path, and ref correctly", async () => {
    const getProject = vi.fn().mockResolvedValue({ default_branch: "main" });
    const getFileContents = vi.fn().mockResolvedValue({
      file_name: "README.md",
      content: "# Hello"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, getFileContents } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_file_contents",
        arguments: {
          project_id: "group/project",
          file_path: "README.md",
          ref: "develop"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getFileContents).toHaveBeenCalledWith("group/project", "README.md", "develop");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("falls back to default_branch when ref is not provided", async () => {
    const getProject = vi.fn().mockResolvedValue({ default_branch: "main" });
    const getFileContents = vi.fn().mockResolvedValue({
      file_name: "README.md",
      content: "# Hello"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, getFileContents } })
    );

    try {
      await client.callTool({
        name: "gitlab_get_file_contents",
        arguments: { project_id: "group/project", file_path: "README.md" }
      });

      expect(getProject).toHaveBeenCalledWith("group/project");
      expect(getFileContents).toHaveBeenCalledWith("group/project", "README.md", "main");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("decodes base64 file contents when requested", async () => {
    const getFileContents = vi.fn().mockResolvedValue({
      file_name: "README.md",
      content: "IyBIZWxsbwo=",
      encoding: "base64"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getFileContents } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_file_contents",
        arguments: {
          project_id: "group/project",
          file_path: "README.md",
          ref: "main",
          decode_base64: true
        }
      });

      const structured = (result as { structuredContent?: { result?: Record<string, unknown> } })
        .structuredContent?.result;
      expect(structured).toMatchObject({
        file_name: "README.md",
        content: "# Hello\n",
        encoding: "utf8"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  HTTP remote file transfer behavior                                 */
/* ------------------------------------------------------------------ */

describe("Tool handlers: HTTP remote file transfers", () => {
  it("returns a proxy URL for job artifacts when local file tools are disabled", async () => {
    const downloadJobArtifacts = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowLocalFileTools: false,
        gitlabStub: { downloadJobArtifacts }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_download_job_artifacts",
        arguments: { project_id: "group/project", job_id: "42" }
      });

      expect(result.isError).toBeFalsy();
      expect(downloadJobArtifacts).not.toHaveBeenCalled();
      const structured = (result as { structuredContent?: { result?: Record<string, unknown> } })
        .structuredContent?.result;
      expect(String(structured?.download_url)).toContain("/downloads/job-artifacts");
      expect(String(structured?.download_url)).toContain("project_id=group%2Fproject");
      expect(structured?.filename).toBe("artifacts_job_42.zip");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("uses inline downloads when HTTP proxy URLs cannot carry fallback OAuth auth", async () => {
    const downloadJobArtifacts = vi.fn().mockResolvedValue({
      fileName: "artifacts.zip",
      contentType: "application/zip",
      base64: "UEsDBA=="
    });
    const context = buildContext({
      allowLocalFileTools: false,
      token: null,
      gitlabStub: { downloadJobArtifacts }
    });
    context.env.GITLAB_USE_OAUTH = true;
    context.env.GITLAB_OAUTH_CLIENT_ID = "oauth-client-id";

    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.callTool({
        name: "gitlab_download_job_artifacts",
        arguments: { project_id: "group/project", job_id: "42" }
      });

      expect(result.isError).toBeFalsy();
      expect(downloadJobArtifacts).toHaveBeenCalledWith("group/project", "42");
      const structured = (result as { structuredContent?: { result?: Record<string, unknown> } })
        .structuredContent?.result;
      expect(structured?.download_url).toBeUndefined();
      expect(structured).toMatchObject({
        fileName: "artifacts.zip",
        contentType: "application/zip",
        base64: "UEsDBA=="
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects local file markdown uploads when local file tools are disabled", async () => {
    const uploadMarkdownFile = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowLocalFileTools: false,
        gitlabStub: { uploadMarkdownFile }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_upload_markdown",
        arguments: { project_id: "group/project", file_path: "/tmp/file.md" }
      });

      expect(result.isError).toBe(true);
      expect(uploadMarkdownFile).not.toHaveBeenCalled();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (item) => item.type === "text"
      )?.text;
      expect(text).toContain("file_path cannot be used over HTTP");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_get_file_blame                                              */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_get_file_blame", () => {
  it("passes file path, ref, and line range", async () => {
    const getFileBlame = vi.fn().mockResolvedValue([
      {
        lines: ["console.log('ok');"],
        commit: { id: "abc123", author_name: "Alice" }
      }
    ]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getFileBlame } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_file_blame",
        arguments: {
          project_id: "group/project",
          file_path: "src/index.ts",
          ref: "main",
          range_start: 10,
          range_end: 20
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getFileBlame).toHaveBeenCalledWith("group/project", "src/index.ts", "main", {
        query: {
          "range[start]": 10,
          "range[end]": 20
        }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects a partial line range", async () => {
    const getFileBlame = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getFileBlame } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_file_blame",
        arguments: {
          project_id: "group/project",
          file_path: "src/index.ts",
          ref: "main",
          range_start: 10
        }
      });

      expect(result.isError).toBe(true);
      expect(getFileBlame).not.toHaveBeenCalled();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("range_start and range_end must be provided together");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects an inverted line range", async () => {
    const getFileBlame = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getFileBlame } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_file_blame",
        arguments: {
          project_id: "group/project",
          file_path: "src/index.ts",
          ref: "main",
          range_start: 20,
          range_end: 10
        }
      });

      expect(result.isError).toBe(true);
      expect(getFileBlame).not.toHaveBeenCalled();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("range_start must be less than or equal to range_end");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Branch tools                                                       */
/* ------------------------------------------------------------------ */

describe("Tool handlers: branch tools", () => {
  it("passes filters to gitlab_list_branches", async () => {
    const listBranches = vi.fn().mockResolvedValue([{ name: "release/1.0" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listBranches } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_branches",
        arguments: {
          project_id: "group/project",
          search: "release",
          sort: "updated_desc",
          page: 2,
          per_page: 20
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listBranches).toHaveBeenCalledWith("group/project", {
        query: expect.objectContaining({
          search: "release",
          sort: "updated_desc",
          page: 2,
          per_page: 20
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes branch name to gitlab_get_branch", async () => {
    const getBranch = vi.fn().mockResolvedValue({ name: "feature/a" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getBranch } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_branch",
        arguments: { project_id: "group/project", branch: "feature/a" }
      });

      expect(result.isError).toBeFalsy();
      expect(getBranch).toHaveBeenCalledWith("group/project", "feature/a");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes search and pagination to gitlab_list_protected_branches", async () => {
    const listProtectedBranches = vi.fn().mockResolvedValue([{ name: "release/*" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listProtectedBranches } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_protected_branches",
        arguments: {
          project_id: "group/project",
          search: "release",
          page: 2,
          per_page: 50
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listProtectedBranches).toHaveBeenCalledWith("group/project", {
        query: { search: "release", page: 2, per_page: 50 }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes wildcard rule to gitlab_get_protected_branch", async () => {
    const getProtectedBranch = vi.fn().mockResolvedValue({ name: "release/*" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProtectedBranch } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_protected_branch",
        arguments: { project_id: "group/project", branch: "release/*" }
      });

      expect(result.isError).toBeFalsy();
      expect(getProtectedBranch).toHaveBeenCalledWith("group/project", "release/*");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects protected-branch reads outside the configured project scope", async () => {
    const listProtectedBranches = vi.fn();
    const getProtectedBranch = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/allowed"],
        gitlabStub: { listProtectedBranches, getProtectedBranch }
      })
    );

    try {
      for (const call of [
        {
          name: "gitlab_list_protected_branches",
          arguments: { project_id: "group/forbidden" }
        },
        {
          name: "gitlab_get_protected_branch",
          arguments: { project_id: "group/forbidden", branch: "main" }
        }
      ]) {
        const result = await client.callTool(call);
        expect(result.isError, call.name).toBe(true);
      }

      expect(listProtectedBranches).not.toHaveBeenCalled();
      expect(getProtectedBranch).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("protects a branch without dropping explicit false and zero values", async () => {
    const protectBranch = vi.fn().mockResolvedValue({ name: "release/*" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { protectBranch } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_protect_branch",
        arguments: {
          project_id: "group/project",
          branch: "release/*",
          push_access_level: 0,
          merge_access_level: 30,
          unprotect_access_level: 40,
          allow_force_push: false,
          code_owner_approval_required: false
        }
      });

      expect(result.isError).toBeFalsy();
      expect(protectBranch).toHaveBeenCalledWith("group/project", {
        name: "release/*",
        push_access_level: 0,
        merge_access_level: 30,
        unprotect_access_level: 40,
        allow_force_push: false,
        code_owner_approval_required: false
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects invalid protected-branch access levels before the API call", async () => {
    const protectBranch = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { protectBranch } })
    );

    try {
      const invalidPush = await client.callTool({
        name: "gitlab_protect_branch",
        arguments: { project_id: "group/project", branch: "main", push_access_level: 20 }
      });
      const invalidUnprotect = await client.callTool({
        name: "gitlab_protect_branch",
        arguments: { project_id: "group/project", branch: "main", unprotect_access_level: 0 }
      });

      expect(invalidPush.isError).toBe(true);
      expect(invalidUnprotect.isError).toBe(true);
      expect(protectBranch).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("unprotects a branch and returns a minimal status", async () => {
    const unprotectBranch = vi.fn().mockResolvedValue("");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { unprotectBranch } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_unprotect_branch",
        arguments: { project_id: "group/project", branch: "release/*" }
      });

      expect(result.isError).toBeFalsy();
      expect(unprotectBranch).toHaveBeenCalledWith("group/project", "release/*");
      expect(result.structuredContent).toMatchObject({
        result: {
          status: "unprotected",
          project_id: "group/project",
          branch: "release/*"
        }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("updates the default branch and returns a minimal status", async () => {
    const updateDefaultBranch = vi.fn().mockResolvedValue({ runners_token: "not-returned" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { updateDefaultBranch } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_update_default_branch",
        arguments: { project_id: "group/project", default_branch: "stable" }
      });

      expect(result.isError).toBeFalsy();
      expect(updateDefaultBranch).toHaveBeenCalledWith("group/project", "stable");
      expect(result.structuredContent).toMatchObject({
        result: {
          status: "updated",
          project_id: "group/project",
          default_branch: "stable"
        }
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("not-returned");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects protected-branch administration outside project scope", async () => {
    const protectBranch = vi.fn();
    const unprotectBranch = vi.fn();
    const updateDefaultBranch = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/allowed"],
        gitlabStub: { protectBranch, unprotectBranch, updateDefaultBranch }
      })
    );

    try {
      for (const call of [
        {
          name: "gitlab_protect_branch",
          arguments: { project_id: "group/forbidden", branch: "main" }
        },
        {
          name: "gitlab_unprotect_branch",
          arguments: { project_id: "group/forbidden", branch: "main" }
        },
        {
          name: "gitlab_update_default_branch",
          arguments: { project_id: "group/forbidden", default_branch: "main" }
        }
      ]) {
        const result = await client.callTool(call);
        expect(result.isError, call.name).toBe(true);
      }

      expect(protectBranch).not.toHaveBeenCalled();
      expect(unprotectBranch).not.toHaveBeenCalled();
      expect(updateDefaultBranch).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes branch name to gitlab_delete_branch", async () => {
    const deleteBranch = vi.fn().mockResolvedValue({ ok: true });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { deleteBranch } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_delete_branch",
        arguments: { project_id: "group/project", branch: "feature/a" }
      });

      expect(result.isError).toBeFalsy();
      expect(deleteBranch).toHaveBeenCalledWith("group/project", "feature/a");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Commit status tools                                                */
/* ------------------------------------------------------------------ */

describe("Tool handlers: commit status tools", () => {
  it("passes filters to gitlab_list_commit_statuses", async () => {
    const listCommitStatuses = vi.fn().mockResolvedValue([{ sha: "abc123", status: "success" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listCommitStatuses } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_commit_statuses",
        arguments: {
          project_id: "group/project",
          sha: "abc123",
          ref: "main",
          name: "external/check",
          all: false,
          page: 2,
          per_page: 20
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listCommitStatuses).toHaveBeenCalledWith("group/project", "abc123", {
        query: expect.objectContaining({
          ref: "main",
          name: "external/check",
          all: false,
          page: 2,
          per_page: 20
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes payload to gitlab_create_commit_status", async () => {
    const createCommitStatus = vi.fn().mockResolvedValue({
      sha: "abc123",
      status: "success"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createCommitStatus } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_commit_status",
        arguments: {
          project_id: "group/project",
          sha: "abc123",
          state: "success",
          context: "external/check",
          target_url: "https://ci.example.com/build/1",
          coverage: 87.5,
          pipeline_id: 42
        }
      });

      expect(result.isError).toBeFalsy();
      expect(createCommitStatus).toHaveBeenCalledWith("group/project", "abc123", {
        state: "success",
        context: "external/check",
        target_url: "https://ci.example.com/build/1",
        coverage: 87.5,
        pipeline_id: 42
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects create commit status with both name and context", async () => {
    const createCommitStatus = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createCommitStatus } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_commit_status",
        arguments: {
          project_id: "group/project",
          sha: "abc123",
          state: "success",
          name: "external/check",
          context: "external/check"
        }
      });

      expect(result.isError).toBe(true);
      expect(createCommitStatus).not.toHaveBeenCalled();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("Use either name or context");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_create_issue (mutating tool)                                */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_create_issue", () => {
  it("constructs payload from args and calls createIssue()", async () => {
    const createIssue = vi.fn().mockResolvedValue({
      iid: 99,
      title: "New bug",
      state: "opened"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createIssue } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_issue",
        arguments: {
          project_id: "group/project",
          title: "New bug",
          description: "Something is broken",
          labels: "bug,urgent"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(createIssue).toHaveBeenCalledWith("group/project", {
        title: "New bug",
        description: "Something is broken",
        labels: "bug,urgent",
        milestone_id: undefined,
        due_date: undefined,
        confidential: undefined,
        issue_type: undefined,
        assignee_ids: undefined
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_get_issue / gitlab_update_issue                             */
/* ------------------------------------------------------------------ */

describe("Tool handlers: slim issue responses", () => {
  it("slims milestone details by default and preserves full_response compatibility", async () => {
    const issue = {
      id: 50,
      iid: 5,
      title: "Bug",
      description: "Issue details",
      milestone: {
        id: 9,
        iid: 3,
        title: "M1",
        state: "active",
        web_url: "https://gitlab.example.com/milestones/3",
        description: "Large milestone description",
        created_at: "2026-01-01T00:00:00Z"
      }
    };
    const getIssue = vi.fn().mockResolvedValue(issue);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getIssue } })
    );

    try {
      const slimResult = await client.callTool({
        name: "gitlab_get_issue",
        arguments: { project_id: "group/project", issue_iid: "5" }
      });
      const fullResult = await client.callTool({
        name: "gitlab_get_issue",
        arguments: { project_id: "group/project", issue_iid: "5", full_response: true }
      });

      expect(slimResult.isError).toBeFalsy();
      expect(
        (slimResult as { structuredContent?: { result?: Record<string, unknown> } })
          .structuredContent?.result
      ).toEqual({
        ...issue,
        milestone: {
          id: 9,
          iid: 3,
          title: "M1",
          state: "active",
          web_url: "https://gitlab.example.com/milestones/3"
        }
      });
      expect(
        (fullResult as { structuredContent?: { result?: Record<string, unknown> } })
          .structuredContent?.result
      ).toEqual(issue);
      expect(getIssue).toHaveBeenNthCalledWith(1, "group/project", "5");
      expect(getIssue).toHaveBeenNthCalledWith(2, "group/project", "5");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns a slim update confirmation unless full_response is requested", async () => {
    const issue = {
      id: 50,
      iid: 5,
      project_id: 10,
      title: "Updated bug",
      state: "opened",
      updated_at: "2026-07-10T00:00:00Z",
      web_url: "https://gitlab.example.com/issues/5",
      description: "Large body",
      author: { id: 1, username: "alice" }
    };
    const updateIssue = vi.fn().mockResolvedValue(issue);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { updateIssue } })
    );

    try {
      const slimResult = await client.callTool({
        name: "gitlab_update_issue",
        arguments: { project_id: "group/project", issue_iid: "5", title: "Updated bug" }
      });
      const fullResult = await client.callTool({
        name: "gitlab_update_issue",
        arguments: {
          project_id: "group/project",
          issue_iid: "5",
          title: "Updated bug",
          full_response: true
        }
      });

      expect(
        (slimResult as { structuredContent?: { result?: Record<string, unknown> } })
          .structuredContent?.result
      ).toEqual({
        id: 50,
        iid: 5,
        project_id: 10,
        title: "Updated bug",
        state: "opened",
        updated_at: "2026-07-10T00:00:00Z",
        web_url: "https://gitlab.example.com/issues/5"
      });
      expect(
        (fullResult as { structuredContent?: { result?: Record<string, unknown> } })
          .structuredContent?.result
      ).toEqual(issue);
      expect(updateIssue).toHaveBeenNthCalledWith(1, "group/project", "5", {
        title: "Updated bug"
      });
      expect(updateIssue).toHaveBeenNthCalledWith(2, "group/project", "5", {
        title: "Updated bug"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_update_issue_description_patch                              */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_update_issue_description_patch", () => {
  it("previews search/replace patches without updating on dry_run", async () => {
    const getIssue = vi.fn().mockResolvedValue({
      iid: 5,
      description: "before\nkeep"
    });
    const updateIssue = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getIssue, updateIssue } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_update_issue_description_patch",
        arguments: {
          project_id: "group/project",
          issue_iid: "5",
          patch_type: "search_replace",
          patch: "<<<<<<< SEARCH\nbefore\n=======\nafter\n>>>>>>> REPLACE",
          dry_run: true
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getIssue).toHaveBeenCalledWith("group/project", "5");
      expect(updateIssue).not.toHaveBeenCalled();

      const structured = (result as { structuredContent?: { result?: Record<string, unknown> } })
        .structuredContent;
      expect(structured?.result).toMatchObject({
        status: "preview",
        dry_run: true,
        changes: 1
      });
      expect(String(structured?.result?.preview)).toContain("after");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("updates the issue description and optionally creates a note", async () => {
    const getIssue = vi.fn().mockResolvedValue({
      iid: 5,
      description: "before\nkeep"
    });
    const updateIssue = vi.fn().mockResolvedValue({
      iid: 5,
      title: "Bug",
      web_url: "https://gitlab.example.com/issue/5",
      updated_at: "2026-05-22T00:00:00Z"
    });
    const createIssueNote = vi.fn().mockResolvedValue({ id: 1 });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getIssue, updateIssue, createIssueNote } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_update_issue_description_patch",
        arguments: {
          project_id: "group/project",
          issue_iid: "5",
          patch_type: "search_replace",
          patch: "<<<<<<< SEARCH\nbefore\n=======\nafter\n>>>>>>> REPLACE",
          create_note: true
        }
      });

      expect(result.isError).toBeFalsy();
      expect(updateIssue).toHaveBeenCalledWith("group/project", "5", {
        description: "after\nkeep"
      });
      expect(createIssueNote).toHaveBeenCalledWith("group/project", "5", {
        body: expect.stringContaining("Updated issue description using patch-based tool")
      });

      const structured = (result as { structuredContent?: { result?: Record<string, unknown> } })
        .structuredContent;
      expect(structured?.result).toMatchObject({
        status: "success",
        changes: 1,
        note: { status: "created" }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_get_merge_request                                           */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_get_merge_request", () => {
  it("passes project_id + merge_request_iid to getMergeRequest()", async () => {
    const getMergeRequest = vi.fn().mockResolvedValue({
      iid: 7,
      title: "Add feature",
      state: "opened"
    });
    const countMergeRequestCommits = vi.fn();
    const getProject = vi.fn();
    const getMergeRequestApprovalState = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: {
          getMergeRequest,
          countMergeRequestCommits,
          getProject,
          getMergeRequestApprovalState
        }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request",
        arguments: { project_id: "group/project", merge_request_iid: "7" }
      });

      expect(result.isError).toBeFalsy();
      expect(getMergeRequest).toHaveBeenCalledWith("group/project", "7");
      expect(countMergeRequestCommits).not.toHaveBeenCalled();
      expect(getProject).not.toHaveBeenCalled();
      expect(getMergeRequestApprovalState).not.toHaveBeenCalled();
      expect(
        (result as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent
          ?.result
      ).not.toHaveProperty("commit_addition_summary");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("adds commit addition and approval summaries", async () => {
    const getMergeRequest = vi.fn().mockResolvedValue({
      iid: 7,
      title: "Add feature",
      state: "opened",
      target_branch: "main",
      diverged_commits_count: 2
    });
    const countMergeRequestCommits = vi.fn().mockResolvedValue(3);
    const getProject = vi.fn().mockResolvedValue({ merge_method: "merge" });
    const getMergeRequestApprovalState = vi.fn().mockResolvedValue({
      approved: true,
      approved_by: [{ id: 1, username: "alice" }],
      approved_by_usernames: ["alice"],
      rules: [{ approved: true }],
      source_endpoint: "approval_state"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: {
          getMergeRequest,
          countMergeRequestCommits,
          getProject,
          getMergeRequestApprovalState
        }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request",
        arguments: {
          project_id: "group/project",
          merge_request_iid: "7",
          include_summaries: true
        }
      });

      expect(result.isError).toBeFalsy();
      const structured = (result as { structuredContent?: { result?: Record<string, unknown> } })
        .structuredContent?.result;
      expect(structured).toMatchObject({
        diverged_commits_count: 2,
        commit_addition_summary: {
          target_branch: "main",
          source_commits_count: 3,
          merge_method: "merge",
          merge_commit_count: 1,
          summary: "3 commits and 1 merge commit will be added to main."
        },
        approval_summary: {
          approved: true,
          approved_by_usernames: ["alice"],
          rules_count: 1,
          source_endpoint: "approval_state"
        }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("prefers opened merge request when source_branch matches multiple states", async () => {
    const listMergeRequests = vi.fn().mockResolvedValue([
      { iid: 10, source_branch: "feature/a", state: "closed" },
      { iid: 11, source_branch: "feature/a", state: "opened" }
    ]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequests } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request",
        arguments: { project_id: "group/project", source_branch: "feature/a" }
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      const parsed = JSON.parse(text) as { iid?: number };
      expect(parsed.iid).toBe(11);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns error when multiple opened merge requests match source_branch", async () => {
    const listMergeRequests = vi.fn().mockResolvedValue([
      { iid: 21, source_branch: "feature/b", state: "opened" },
      { iid: 22, source_branch: "feature/b", state: "opened" }
    ]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequests } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request",
        arguments: { project_id: "group/project", source_branch: "feature/b" }
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("Multiple opened merge requests found");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("ignores merge requests whose source_branch is missing", async () => {
    const listMergeRequests = vi.fn().mockResolvedValue([
      { iid: 51, state: "opened" },
      { iid: 52, source_branch: "feature/e", state: "opened" }
    ]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequests } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request",
        arguments: { project_id: "group/project", source_branch: "feature/e" }
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      const parsed = JSON.parse(text) as { iid?: number };
      expect(parsed.iid).toBe(52);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_list_merge_requests                                         */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_list_merge_requests", () => {
  it("prefers *_username filters over *_id filters to avoid GitLab 400s", async () => {
    const listMergeRequests = vi.fn().mockResolvedValue([]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequests } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_merge_requests",
        arguments: {
          project_id: "group/project",
          author_id: "1",
          author_username: "alice",
          assignee_id: "2",
          assignee_username: "bob",
          reviewer_id: "3",
          reviewer_username: "carol"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listMergeRequests).toHaveBeenCalledWith("group/project", {
        query: {
          author_username: "alice",
          assignee_username: "bob",
          reviewer_username: "carol"
        }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes approved_by_usernames as an array query filter", async () => {
    const listMergeRequests = vi.fn().mockResolvedValue([]);
    const pair = await createLinkedPair(buildContext({ gitlabStub: { listMergeRequests } }));

    try {
      const result = await pair.client.callTool({
        name: "gitlab_list_merge_requests",
        arguments: {
          project_id: "group/project",
          approved_by_usernames: ["alice", "bob"]
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listMergeRequests).toHaveBeenCalledWith("group/project", {
        query: { approved_by_usernames: ["alice", "bob"] }
      });
    } finally {
      await pair.clientTransport.close();
      await pair.serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_get_merge_request_conflicts                                 */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_get_merge_request_conflicts", () => {
  it("passes project_id + merge_request_iid to getMergeRequestConflicts()", async () => {
    const getMergeRequestConflicts = vi.fn().mockResolvedValue({
      merge_request: { iid: 11 },
      conflict_files: []
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getMergeRequestConflicts } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request_conflicts",
        arguments: { project_id: "group/project", merge_request_iid: "11" }
      });

      expect(result.isError).toBeFalsy();
      expect(getMergeRequestConflicts).toHaveBeenCalledWith("group/project", "11");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_list_merge_request_pipelines                                */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_list_merge_request_pipelines", () => {
  it("passes project_id, merge_request_iid, and pagination", async () => {
    const listMergeRequestPipelines = vi.fn().mockResolvedValue([{ id: 77, status: "success" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequestPipelines } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_merge_request_pipelines",
        arguments: {
          project_id: "group/project",
          merge_request_iid: "11",
          page: 2,
          per_page: 10
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listMergeRequestPipelines).toHaveBeenCalledWith("group/project", "11", {
        query: expect.objectContaining({
          page: 2,
          per_page: 10
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  MR large diff workflow                                             */
/* ------------------------------------------------------------------ */

describe("Tool handlers: MR large diff workflow", () => {
  it("filters branch diffs locally without forwarding exclusion patterns", async () => {
    const getBranchDiffs = vi.fn().mockResolvedValue({
      commit: { id: "abc" },
      diffs: [
        { new_path: "src/index.ts", old_path: "src/index.ts", diff: "source" },
        {
          new_path: "vendor/generated.js",
          old_path: "vendor/generated.js",
          diff: "generated"
        }
      ]
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getBranchDiffs } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_branch_diffs",
        arguments: {
          project_id: "group/project",
          from: "main",
          to: "feature",
          straight: true,
          excluded_file_patterns: ["^vendor/"]
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getBranchDiffs).toHaveBeenCalledWith("group/project", {
        from: "main",
        to: "feature",
        straight: true
      });
      expect(
        (result as { structuredContent?: { result?: unknown } }).structuredContent?.result
      ).toEqual({
        commit: { id: "abc" },
        diffs: [{ new_path: "src/index.ts", old_path: "src/index.ts", diff: "source" }]
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("filters MR diffs locally and only forwards supported GitLab query fields", async () => {
    const getMergeRequestDiffs = vi.fn().mockResolvedValue({
      changes: [
        { new_path: "src/index.ts", old_path: "src/index.ts", diff: "source" },
        {
          new_path: "vendor/generated.js",
          old_path: "vendor/generated.js",
          diff: "generated"
        }
      ]
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getMergeRequestDiffs } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request_diffs",
        arguments: {
          project_id: "group/project",
          merge_request_iid: "11",
          view: "inline",
          excluded_file_patterns: ["^vendor/"]
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getMergeRequestDiffs).toHaveBeenCalledWith("group/project", "11", {
        query: { view: "inline" }
      });
      expect(
        (result as { structuredContent?: { result?: unknown } }).structuredContent?.result
      ).toEqual({
        changes: [{ new_path: "src/index.ts", old_path: "src/index.ts", diff: "source" }]
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("lists changed files without diff content and applies exclusions", async () => {
    const getMergeRequestDiffs = vi.fn().mockResolvedValue({
      changes: [
        {
          new_path: "src/index.ts",
          old_path: "src/index.ts",
          new_file: false,
          deleted_file: false,
          renamed_file: false,
          diff: "@@ -1 +1 @@"
        },
        {
          new_path: "vendor/generated.js",
          old_path: "vendor/generated.js",
          new_file: false,
          deleted_file: false,
          renamed_file: false,
          diff: "large"
        }
      ]
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getMergeRequestDiffs } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_merge_request_changed_files",
        arguments: {
          project_id: "group/project",
          merge_request_iid: "11",
          excluded_file_patterns: ["^vendor/"]
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getMergeRequestDiffs).toHaveBeenCalledWith("group/project", "11");

      const structured = (
        result as {
          structuredContent?: { result?: { items?: unknown[]; count?: number } };
        }
      ).structuredContent;
      expect(structured?.result?.items).toEqual([
        {
          new_path: "src/index.ts",
          old_path: "src/index.ts",
          new_file: false,
          deleted_file: false,
          renamed_file: false
        }
      ]);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns requested file diffs and not-found results", async () => {
    const listMergeRequestDiffs = vi.fn().mockResolvedValue([
      {
        new_path: "src/index.ts",
        old_path: "src/index.ts",
        diff: "@@ -1 +1 @@"
      }
    ]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequestDiffs } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request_file_diff",
        arguments: {
          project_id: "group/project",
          merge_request_iid: "11",
          file_paths: ["src/index.ts", "missing.ts"],
          unidiff: true
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listMergeRequestDiffs).toHaveBeenCalledWith("group/project", "11", {
        query: expect.objectContaining({
          page: 1,
          per_page: 20,
          unidiff: true
        })
      });

      const structured = (
        result as {
          structuredContent?: { result?: { items?: unknown[]; count?: number } };
        }
      ).structuredContent;
      expect(structured?.result?.items?.[0]).toMatchObject({ new_path: "src/index.ts" });
      expect(structured?.result?.items?.[1]).toMatchObject({
        file_path: "missing.ts",
        error: "File not found in merge request diffs: missing.ts"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_merge_merge_request                                         */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_merge_merge_request", () => {
  it("selects opened merge request when only source_branch is provided", async () => {
    const listMergeRequests = vi.fn().mockResolvedValue([
      { iid: 31, source_branch: "feature/c", state: "closed" },
      { iid: 32, source_branch: "feature/c", state: "opened" }
    ]);
    const mergeMergeRequest = vi.fn().mockResolvedValue({
      iid: 32,
      state: "merged"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequests, mergeMergeRequest } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_merge_merge_request",
        arguments: { project_id: "group/project", source_branch: "feature/c" }
      });

      expect(result.isError).toBeFalsy();
      expect(mergeMergeRequest).toHaveBeenCalledWith("group/project", "32", {});
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns error when no opened merge request matches source_branch", async () => {
    const listMergeRequests = vi
      .fn()
      .mockResolvedValue([{ iid: 41, source_branch: "feature/d", state: "closed" }]);
    const mergeMergeRequest = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listMergeRequests, mergeMergeRequest } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_merge_merge_request",
        arguments: { project_id: "group/project", source_branch: "feature/d" }
      });

      expect(result.isError).toBe(true);
      expect(mergeMergeRequest).not.toHaveBeenCalled();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("No opened merge request found");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_list_issues                                                 */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_list_issues", () => {
  it("passes filter params via toQuery()", async () => {
    const listIssues = vi.fn().mockResolvedValue([
      { iid: 1, title: "Bug" },
      { iid: 2, title: "Feature" }
    ]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listIssues } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_issues",
        arguments: {
          project_id: "group/project",
          state: "opened",
          labels: "bug",
          search: "crash"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listIssues).toHaveBeenCalledWith("group/project", {
        query: expect.objectContaining({
          state: "opened",
          labels: "bug",
          search: "crash"
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("drops conflicting ID filters when non-empty username filters are present", async () => {
    const listIssues = vi.fn().mockResolvedValue([]);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listIssues } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_issues",
        arguments: {
          project_id: "group/project",
          author_id: 1,
          author_username: "alice",
          assignee_id: 2,
          assignee_username: ["bob"]
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listIssues).toHaveBeenCalledWith("group/project", {
        query: {
          author_username: "alice",
          assignee_username: "bob"
        }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  User tools                                                         */
/* ------------------------------------------------------------------ */

describe("Tool handlers: user tools", () => {
  it("passes user_id to gitlab_get_user", async () => {
    const getUser = vi.fn().mockResolvedValue({
      id: 42,
      username: "alice"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getUser } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_user",
        arguments: { user_id: "42" }
      });

      expect(result.isError).toBeFalsy();
      expect(getUser).toHaveBeenCalledWith("42");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("calls gitlab_whoami without arguments", async () => {
    const whoami = vi.fn().mockResolvedValue({
      id: 42,
      username: "alice"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { whoami } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_whoami",
        arguments: {}
      });

      expect(result.isError).toBeFalsy();
      expect(whoami).toHaveBeenCalledWith();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Todo tools                                                         */
/* ------------------------------------------------------------------ */

describe("Tool handlers: todo tools", () => {
  it("passes filters to gitlab_list_todos", async () => {
    const listTodos = vi.fn().mockResolvedValue([{ id: 102, state: "pending" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listTodos } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_todos",
        arguments: {
          state: "pending",
          action: "assigned",
          project_id: 123,
          page: 2,
          per_page: 5
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listTodos).toHaveBeenCalledWith({
        query: expect.objectContaining({
          state: "pending",
          action: "assigned",
          project_id: 123,
          page: 2,
          per_page: 5
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes todo_id to gitlab_mark_todo_done", async () => {
    const markTodoDone = vi.fn().mockResolvedValue({ id: 102, state: "done" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { markTodoDone } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_mark_todo_done",
        arguments: { todo_id: "102" }
      });

      expect(result.isError).toBeFalsy();
      expect(markTodoDone).toHaveBeenCalledWith("102");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns a success payload for gitlab_mark_all_todos_done", async () => {
    const markAllTodosDone = vi.fn().mockResolvedValue("");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { markAllTodosDone } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_mark_all_todos_done",
        arguments: {}
      });

      expect(result.isError).toBeFalsy();
      expect(markAllTodosDone).toHaveBeenCalledWith();

      const structured = (result as { structuredContent?: { result?: unknown } }).structuredContent;
      expect(structured?.result).toEqual({
        status: "success",
        message: "All pending to-do items marked as done"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("hides todo mutations in read-only mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true })
    );

    try {
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name);

      expect(names).toContain("gitlab_list_todos");
      expect(names).not.toContain("gitlab_mark_todo_done");
      expect(names).not.toContain("gitlab_mark_all_todos_done");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Emoji reaction tools                                               */
/* ------------------------------------------------------------------ */

describe("Tool handlers: emoji reaction tools", () => {
  it("passes arguments to merge request emoji reaction methods", async () => {
    const listMergeRequestEmojiReactions = vi.fn().mockResolvedValue([{ id: 1, name: "rocket" }]);
    const createMergeRequestNoteEmojiReaction = vi.fn().mockResolvedValue({
      id: 2,
      name: "thumbsup"
    });
    const deleteMergeRequestNoteEmojiReaction = vi.fn().mockResolvedValue("");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: {
          listMergeRequestEmojiReactions,
          createMergeRequestNoteEmojiReaction,
          deleteMergeRequestNoteEmojiReaction
        }
      })
    );

    try {
      await client.callTool({
        name: "gitlab_list_merge_request_emoji_reactions",
        arguments: { project_id: "group/project", merge_request_iid: "7", page: 2 }
      });
      await client.callTool({
        name: "gitlab_create_merge_request_note_emoji_reaction",
        arguments: {
          project_id: "group/project",
          merge_request_iid: "7",
          note_id: "33",
          discussion_id: "disc-1",
          name: "thumbsup"
        }
      });
      await client.callTool({
        name: "gitlab_delete_merge_request_note_emoji_reaction",
        arguments: {
          project_id: "group/project",
          merge_request_iid: "7",
          note_id: "33",
          discussion_id: "disc-1",
          award_id: "2"
        }
      });

      expect(listMergeRequestEmojiReactions).toHaveBeenCalledWith("group/project", "7", {
        query: expect.objectContaining({ page: 2 })
      });
      expect(createMergeRequestNoteEmojiReaction).toHaveBeenCalledWith("group/project", "7", "33", {
        name: "thumbsup",
        discussion_id: "disc-1"
      });
      expect(deleteMergeRequestNoteEmojiReaction).toHaveBeenCalledWith("group/project", "7", "33", {
        award_id: "2",
        discussion_id: "disc-1"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes arguments to issue emoji reaction methods", async () => {
    const listIssueNoteEmojiReactions = vi.fn().mockResolvedValue([{ id: 1, name: "eyes" }]);
    const createIssueEmojiReaction = vi.fn().mockResolvedValue({ id: 2, name: "rocket" });
    const deleteIssueEmojiReaction = vi.fn().mockResolvedValue("");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: {
          listIssueNoteEmojiReactions,
          createIssueEmojiReaction,
          deleteIssueEmojiReaction
        }
      })
    );

    try {
      await client.callTool({
        name: "gitlab_list_issue_note_emoji_reactions",
        arguments: { project_id: "group/project", issue_iid: "5", note_id: "44", per_page: 10 }
      });
      await client.callTool({
        name: "gitlab_create_issue_emoji_reaction",
        arguments: { project_id: "group/project", issue_iid: "5", name: "rocket" }
      });
      await client.callTool({
        name: "gitlab_delete_issue_emoji_reaction",
        arguments: { project_id: "group/project", issue_iid: "5", award_id: "2" }
      });

      expect(listIssueNoteEmojiReactions).toHaveBeenCalledWith(
        "group/project",
        "5",
        "44",
        {
          discussion_id: undefined
        },
        {
          query: expect.objectContaining({ per_page: 10 })
        }
      );
      expect(createIssueEmojiReaction).toHaveBeenCalledWith("group/project", "5", "rocket");
      expect(deleteIssueEmojiReaction).toHaveBeenCalledWith("group/project", "5", "2");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("hides emoji reaction mutations in read-only mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true })
    );

    try {
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name);

      expect(names).toContain("gitlab_list_issue_emoji_reactions");
      expect(names).toContain("gitlab_list_merge_request_emoji_reactions");
      expect(names).not.toContain("gitlab_create_issue_emoji_reaction");
      expect(names).not.toContain("gitlab_delete_merge_request_emoji_reaction");
      expect(names).not.toContain("gitlab_create_merge_request_note_emoji_reaction");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Work item GraphQL tools                                            */
/* ------------------------------------------------------------------ */

describe("Tool handlers: work item GraphQL tools", () => {
  it("gets and flattens a work item", async () => {
    const getProject = vi.fn().mockResolvedValue({ path_with_namespace: "group/project" });
    const executeGraphql = vi.fn().mockResolvedValue({
      data: {
        namespace: {
          workItem: {
            id: "gid://gitlab/WorkItem/1",
            iid: "5",
            title: "Investigate outage",
            state: "opened",
            webUrl: "https://gitlab.example.com/group/project/-/work_items/5",
            workItemType: { name: "Incident" },
            widgets: [
              {
                __typename: "WorkItemWidgetStatus",
                status: { id: "gid://gitlab/Status/1", name: "In progress", category: "ACTIVE" }
              },
              {
                __typename: "WorkItemWidgetLabels",
                labels: { nodes: [{ title: "sev2" }] }
              }
            ]
          }
        }
      }
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_work_item",
        arguments: { project_id: "group/project", iid: 5 }
      });

      expect(result.isError).toBeFalsy();
      expect(getProject).toHaveBeenCalledWith("group/project");
      expect(executeGraphql).toHaveBeenCalledWith(
        expect.stringContaining("workItem(iid: $iid)"),
        expect.objectContaining({ path: "group/project", iid: "5" })
      );

      const structured = (result as { structuredContent?: { result?: Record<string, unknown> } })
        .structuredContent;
      expect(structured?.result).toEqual(
        expect.objectContaining({
          iid: "5",
          title: "Investigate outage",
          type: "Incident",
          status: expect.objectContaining({ name: "In progress" }),
          labels: ["sev2"]
        })
      );
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("creates work items after resolving type, labels, and assignees", async () => {
    const getProject = vi.fn().mockResolvedValue({ path_with_namespace: "group/project" });
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          namespace: {
            workItemTypes: {
              nodes: [{ id: "gid://gitlab/WorkItems::Type/1", name: "Task" }]
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          project: { labels: { nodes: [{ id: "gid://gitlab/ProjectLabel/9", title: "backend" }] } },
          users: { nodes: [{ id: "gid://gitlab/User/7", username: "alice" }] }
        }
      })
      .mockResolvedValueOnce({
        data: {
          workItemCreate: {
            workItem: {
              id: "gid://gitlab/WorkItem/10",
              iid: "10",
              title: "Implement cache",
              webUrl: "https://gitlab.example.com/group/project/-/work_items/10",
              workItemType: { name: "Task" }
            },
            errors: []
          }
        }
      });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_work_item",
        arguments: {
          project_id: "group/project",
          title: "Implement cache",
          type: "task",
          labels: ["backend"],
          assignee_usernames: ["alice"],
          milestone_id: "12"
        }
      });

      expect(result.isError).toBeFalsy();
      const [, createVariables] = executeGraphql.mock.calls[2] as [string, Record<string, unknown>];
      expect(createVariables).toEqual(
        expect.objectContaining({
          projectPath: "group/project",
          title: "Implement cache",
          typeId: "gid://gitlab/WorkItems::Type/1",
          labelIds: ["gid://gitlab/ProjectLabel/9"],
          assigneeIds: ["gid://gitlab/User/7"],
          milestoneId: "gid://gitlab/Milestone/12"
        })
      );
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("creates incident timeline events with Issue GIDs", async () => {
    const getProject = vi.fn().mockResolvedValue({ path_with_namespace: "group/project" });
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          namespace: {
            workItem: { id: "gid://gitlab/WorkItem/99" }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          timelineEventCreate: {
            timelineEvent: { id: "gid://gitlab/TimelineEvent/1", note: "Impact detected" },
            errors: []
          }
        }
      });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_timeline_event",
        arguments: {
          project_id: "group/project",
          incident_iid: 42,
          note: "Impact detected",
          occurred_at: "2026-05-22T12:00:00.000Z",
          tag_names: ["Impact detected"]
        }
      });

      expect(result.isError).toBeFalsy();
      const [, variables] = executeGraphql.mock.calls[1] as [
        string,
        { input: Record<string, unknown> }
      ];
      expect(variables.input).toEqual(
        expect.objectContaining({
          incidentId: "gid://gitlab/Issue/99",
          note: "Impact detected",
          timelineEventTagNames: ["Impact detected"]
        })
      );
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("creates work item emoji reactions through GraphQL award emoji", async () => {
    const getProject = vi.fn().mockResolvedValue({ path_with_namespace: "group/project" });
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          namespace: {
            workItem: { id: "gid://gitlab/WorkItem/10" }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          awardEmojiAdd: {
            awardEmoji: { name: "rocket", user: { username: "alice" } },
            errors: []
          }
        }
      });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_work_item_emoji_reaction",
        arguments: {
          project_id: "group/project",
          iid: 10,
          name: "rocket"
        }
      });

      expect(result.isError).toBeFalsy();
      const [, variables] = executeGraphql.mock.calls[1] as [string, Record<string, unknown>];
      expect(variables).toEqual({
        awardableId: "gid://gitlab/WorkItem/10",
        name: "rocket"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("validates work item note ownership before adding note emoji reactions", async () => {
    const getProject = vi.fn().mockResolvedValue({ path_with_namespace: "group/project" });
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          namespace: {
            workItem: {
              widgets: [
                {
                  discussions: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "gid://gitlab/Discussion/1",
                        notes: {
                          nodes: [
                            {
                              id: "gid://gitlab/Note/77",
                              body: "note",
                              author: { username: "alice" }
                            }
                          ]
                        }
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          awardEmojiAdd: {
            awardEmoji: { name: "eyes", user: { username: "alice" } },
            errors: []
          }
        }
      });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_work_item_note_emoji_reaction",
        arguments: {
          project_id: "group/project",
          iid: 10,
          note_id: "gid://gitlab/Note/77",
          name: "eyes"
        }
      });

      expect(result.isError).toBeFalsy();
      const [, variables] = executeGraphql.mock.calls[1] as [string, Record<string, unknown>];
      expect(variables).toEqual({
        awardableId: "gid://gitlab/Note/77",
        name: "eyes"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects work item note emoji reactions for notes outside the target work item", async () => {
    const getProject = vi.fn().mockResolvedValue({ path_with_namespace: "group/project" });
    const executeGraphql = vi.fn().mockResolvedValueOnce({
      data: {
        namespace: {
          workItem: {
            widgets: [
              {
                discussions: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: []
                }
              }
            ]
          }
        }
      }
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject, executeGraphql } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_work_item_note_emoji_reaction",
        arguments: {
          project_id: "group/project",
          iid: 10,
          note_id: "gid://gitlab/Note/99",
          name: "eyes"
        }
      });

      expect(result.isError).toBe(true);
      expect(executeGraphql).toHaveBeenCalledTimes(1);
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (item) => item.type === "text"
      )!.text;
      expect(text).toContain("was not found on work item #10");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("hides work item mutations in read-only mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true })
    );

    try {
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name);

      expect(names).toContain("gitlab_get_work_item");
      expect(names).toContain("gitlab_list_custom_field_definitions");
      expect(names).not.toContain("gitlab_create_work_item");
      expect(names).not.toContain("gitlab_update_work_item");
      expect(names).not.toContain("gitlab_create_timeline_event");
      expect(names).not.toContain("gitlab_create_work_item_emoji_reaction");
      expect(names).not.toContain("gitlab_delete_work_item_note_emoji_reaction");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Webhook tools                                                      */
/* ------------------------------------------------------------------ */

describe("Tool handlers: webhook tools", () => {
  it("passes project scope to gitlab_list_webhooks", async () => {
    const listWebhooks = vi.fn().mockResolvedValue([{ id: 7, url: "https://example.com" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listWebhooks } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_webhooks",
        arguments: { project_id: "group/project", page: 2 }
      });

      expect(result.isError).toBeFalsy();
      expect(listWebhooks).toHaveBeenCalledWith(
        { projectId: "group/project" },
        {
          query: expect.objectContaining({ page: 2 })
        }
      );
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects webhook tools without exactly one scope", async () => {
    const listWebhooks = vi.fn();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listWebhooks } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_webhooks",
        arguments: { project_id: "group/project", group_id: "group" }
      });

      expect(result.isError).toBe(true);
      expect(listWebhooks).not.toHaveBeenCalled();
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("Provide exactly one of project_id or group_id");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("summarizes webhook events", async () => {
    const listWebhookEvents = vi.fn().mockResolvedValue(
      attachPaginationMetadata(
        [
          {
            id: 1,
            url: "https://example.com",
            trigger: "push_hooks",
            response_status: "200",
            execution_duration: 0.42,
            request_data: "large"
          }
        ],
        { page: 1, next_page: 2, per_page: 20 }
      )
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listWebhookEvents } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_webhook_events",
        arguments: {
          group_id: "parent/group",
          hook_id: "7",
          status: "successful",
          summary: true
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listWebhookEvents).toHaveBeenCalledWith({ groupId: "parent/group" }, "7", {
        query: expect.objectContaining({
          status: "successful",
          per_page: 20
        })
      });
      const structured = (
        result as {
          structuredContent?: {
            result?: { items?: Array<Record<string, unknown>> };
            meta?: { pagination?: Record<string, unknown> };
          };
        }
      ).structuredContent;
      expect(structured?.result?.items?.[0]).toEqual({
        id: 1,
        url: "https://example.com",
        trigger: "push_hooks",
        response_status: "200",
        execution_duration: 0.42
      });
      expect(structured?.meta?.pagination).toEqual({ page: 1, next_page: 2, per_page: 20 });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("finds webhook events by direct page", async () => {
    const listWebhookEvents = vi.fn().mockResolvedValue([{ id: 101, response_status: "500" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listWebhookEvents } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_webhook_event",
        arguments: {
          project_id: "group/project",
          hook_id: "7",
          event_id: "101",
          page: 3
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listWebhookEvents).toHaveBeenCalledWith({ projectId: "group/project" }, "7", {
        query: { page: 3, per_page: 20 }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Project and group wiki tools                                       */
/* ------------------------------------------------------------------ */

describe("Tool handlers: project wiki tools", () => {
  it("forwards render_html and preserves returned front matter", async () => {
    const listWikiPages = vi
      .fn()
      .mockResolvedValue([{ slug: "home", front_matter: { title: "Custom home" } }]);
    const getWikiPage = vi.fn().mockResolvedValue({
      slug: "home",
      content: "<p>Hello</p>",
      front_matter: { title: "Custom home" }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listWikiPages, getWikiPage } })
    );

    try {
      await client.callTool({
        name: "gitlab_list_wiki_pages",
        arguments: {
          project_id: "group/project",
          with_content: true,
          render_html: true
        }
      });
      const result = await client.callTool({
        name: "gitlab_get_wiki_page",
        arguments: { project_id: "group/project", slug: "home", render_html: true }
      });

      expect(listWikiPages).toHaveBeenCalledWith("group/project", {
        query: { with_content: true, render_html: true }
      });
      expect(getWikiPage).toHaveBeenCalledWith("group/project", "home", {
        query: { render_html: true }
      });
      expect(
        (result as { structuredContent?: { result?: Record<string, unknown> } }).structuredContent
          ?.result
      ).toMatchObject({ front_matter: { title: "Custom home" } });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("preserves a nested page parent when updating a leaf-only title", async () => {
    const getWikiPage = vi.fn().mockResolvedValue({
      slug: "guides/install",
      title: "guides/Install guide"
    });
    const updateWikiPage = vi.fn().mockResolvedValue({
      slug: "guides/setup",
      title: "guides/Setup guide"
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getWikiPage, updateWikiPage } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_update_wiki_page",
        arguments: {
          project_id: "group/project",
          slug: "guides/install",
          title: "Setup guide",
          content: "Updated"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getWikiPage).toHaveBeenCalledWith("group/project", "guides/install", {
        query: { render_html: true }
      });
      expect(updateWikiPage).toHaveBeenCalledWith("group/project", "guides/install", {
        content: "Updated",
        title: "guides/Setup guide",
        format: undefined
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

describe("Tool handlers: group wiki tools", () => {
  it("passes render options to group wiki reads and preserves front matter", async () => {
    const listGroupWikiPages = vi.fn().mockResolvedValue([{ slug: "home" }]);
    const getGroupWikiPage = vi.fn().mockResolvedValue({
      slug: "home",
      front_matter: { title: "Custom group home" }
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listGroupWikiPages, getGroupWikiPage } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_group_wiki_pages",
        arguments: {
          group_id: "parent/group",
          with_content: true,
          render_html: true,
          page: 2
        }
      });
      const pageResult = await client.callTool({
        name: "gitlab_get_group_wiki_page",
        arguments: { group_id: "parent/group", slug: "home", render_html: true }
      });

      expect(result.isError).toBeFalsy();
      expect(listGroupWikiPages).toHaveBeenCalledWith("parent/group", {
        query: expect.objectContaining({ with_content: true, render_html: true, page: 2 })
      });
      expect(getGroupWikiPage).toHaveBeenCalledWith("parent/group", "home", {
        query: { render_html: true }
      });
      expect(
        (pageResult as { structuredContent?: { result?: Record<string, unknown> } })
          .structuredContent?.result
      ).toMatchObject({ front_matter: { title: "Custom group home" } });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("creates, updates, and deletes group wiki pages", async () => {
    const createGroupWikiPage = vi.fn().mockResolvedValue({ slug: "home" });
    const updateGroupWikiPage = vi.fn().mockResolvedValue({ slug: "home" });
    const deleteGroupWikiPage = vi.fn().mockResolvedValue("");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: { createGroupWikiPage, updateGroupWikiPage, deleteGroupWikiPage }
      })
    );

    try {
      await client.callTool({
        name: "gitlab_create_group_wiki_page",
        arguments: {
          group_id: "parent/group",
          title: "Home",
          content: "Hello",
          format: "markdown"
        }
      });
      await client.callTool({
        name: "gitlab_update_group_wiki_page",
        arguments: {
          group_id: "parent/group",
          slug: "home",
          content: "Updated"
        }
      });
      await client.callTool({
        name: "gitlab_delete_group_wiki_page",
        arguments: { group_id: "parent/group", slug: "home" }
      });

      expect(createGroupWikiPage).toHaveBeenCalledWith("parent/group", {
        title: "Home",
        content: "Hello",
        format: "markdown"
      });
      expect(updateGroupWikiPage).toHaveBeenCalledWith("parent/group", "home", {
        content: "Updated"
      });
      expect(deleteGroupWikiPage).toHaveBeenCalledWith("parent/group", "home");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("preserves nested group wiki parents on leaf title updates", async () => {
    const getGroupWikiPage = vi.fn().mockResolvedValue({
      slug: "runbooks/deploy",
      title: "runbooks/Deploy"
    });
    const updateGroupWikiPage = vi.fn().mockResolvedValue({ slug: "runbooks/release" });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getGroupWikiPage, updateGroupWikiPage } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_update_group_wiki_page",
        arguments: {
          group_id: "parent/group",
          slug: "runbooks/deploy",
          title: "Release",
          content: "Updated"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getGroupWikiPage).toHaveBeenCalledWith("parent/group", "runbooks/deploy", {
        query: { render_html: true }
      });
      expect(updateGroupWikiPage).toHaveBeenCalledWith("parent/group", "runbooks/deploy", {
        title: "runbooks/Release",
        content: "Updated"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  CI lint tools                                                      */
/* ------------------------------------------------------------------ */

describe("Tool handlers: CI lint tools", () => {
  it("passes content payload to gitlab_validate_ci_lint", async () => {
    const validateCiLint = vi.fn().mockResolvedValue({
      valid: true,
      errors: []
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { validateCiLint } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_validate_ci_lint",
        arguments: {
          project_id: "group/project",
          content: "test:\n  script: echo ok",
          dry_run: true,
          include_jobs: true,
          ref: "main"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(validateCiLint).toHaveBeenCalledWith("group/project", {
        content: "test:\n  script: echo ok",
        dry_run: true,
        include_jobs: true,
        ref: "main"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes query options to gitlab_validate_project_ci_lint", async () => {
    const validateProjectCiLint = vi.fn().mockResolvedValue({
      valid: true,
      errors: []
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { validateProjectCiLint } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_validate_project_ci_lint",
        arguments: {
          project_id: "group/project",
          content_ref: "feature/test",
          dry_run: true,
          dry_run_ref: "main",
          include_jobs: true
        }
      });

      expect(result.isError).toBeFalsy();
      expect(validateProjectCiLint).toHaveBeenCalledWith("group/project", {
        query: expect.objectContaining({
          content_ref: "feature/test",
          dry_run: true,
          dry_run_ref: "main",
          include_jobs: true
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns a normal invalid lint result for gitlab_validate_ci_lint HTTP 400 diagnostics", async () => {
    const lintMessage =
      "This GitLab CI configuration is invalid: gitlab.com/myorg/devops/gitlab/components/sonarqube@main: unknown input arguments: sonar_java_version, sonar_jacoco_report_paths";
    const validateCiLint = vi
      .fn()
      .mockRejectedValue(new GitLabApiError("Bad Request", 400, { message: lintMessage }));
    const context = buildContext({ gitlabStub: { validateCiLint } });
    context.env.GITLAB_ERROR_DETAIL_MODE = "safe";

    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.callTool({
        name: "gitlab_validate_ci_lint",
        arguments: {
          project_id: "group/project",
          content: "include: []"
        }
      });

      expect(result.isError).toBeFalsy();
      const textContent = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      );
      const parsed = JSON.parse(textContent!.text) as {
        valid?: boolean;
        errors?: string[];
        status?: number;
      };
      expect(parsed.valid).toBe(false);
      expect(parsed.errors).toEqual([lintMessage]);
      expect(parsed.status).toBe(400);

      const structured = (
        result as { structuredContent?: { result?: { valid?: boolean; errors?: string[] } } }
      ).structuredContent?.result;
      expect(structured?.valid).toBe(false);
      expect(structured?.errors).toEqual([lintMessage]);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns a normal invalid lint result for gitlab_validate_project_ci_lint HTTP 400 errors", async () => {
    const lintErrors = ["jobs config should contain at least one visible job"];
    const validateProjectCiLint = vi.fn().mockRejectedValue(
      new GitLabApiError("Bad Request", 400, {
        errors: lintErrors,
        warnings: ["deprecated keyword"]
      })
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { validateProjectCiLint } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_validate_project_ci_lint",
        arguments: {
          project_id: "group/project",
          content_ref: "feature/test"
        }
      });

      expect(result.isError).toBeFalsy();
      const textContent = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      );
      const parsed = JSON.parse(textContent!.text) as {
        valid?: boolean;
        errors?: string[];
        warnings?: string[];
        status?: number;
      };
      expect(parsed).toMatchObject({
        valid: false,
        errors: lintErrors,
        warnings: ["deprecated keyword"],
        status: 400
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("accepts CI lint HTTP 400 errors arrays without fixed message prefixes", async () => {
    const lintErrors = [
      "gitlab.com/myorg/devops/gitlab/components/sonarqube@main: unknown input arguments: sonar_java_version"
    ];
    const validateCiLint = vi.fn().mockRejectedValue(
      new GitLabApiError("Bad Request", 400, {
        errors: lintErrors
      })
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { validateCiLint } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_validate_ci_lint",
        arguments: {
          project_id: "group/project",
          content: "include: []"
        }
      });

      expect(result.isError).toBeFalsy();
      const structured = (
        result as { structuredContent?: { result?: { valid?: boolean; errors?: string[] } } }
      ).structuredContent?.result;
      expect(structured?.valid).toBe(false);
      expect(structured?.errors).toEqual(lintErrors);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("keeps non-lint GitLab 400 responses as tool errors", async () => {
    const validateCiLint = vi
      .fn()
      .mockRejectedValue(new GitLabApiError("Bad Request", 400, { message: "Bad request" }));

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { validateCiLint } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_validate_ci_lint",
        arguments: {
          project_id: "group/project",
          content: "include: []"
        }
      });

      expect(result.isError).toBe(true);
      const textContent = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      );
      expect(textContent?.text).toContain("GitLab API error 400");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  gitlab_create_pipeline                                             */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_create_pipeline", () => {
  it("passes variables and inputs to createPipeline()", async () => {
    const createPipeline = vi.fn().mockResolvedValue({
      id: 100,
      status: "pending"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createPipeline } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_pipeline",
        arguments: {
          project_id: "group/project",
          ref: "main",
          inputs: {
            environment: "production",
            approvals_required: 2,
            dry_run: false,
            regions: ["cn", "us-east"]
          },
          variables: [{ key: "DEPLOY", value: "true" }]
        }
      });

      expect(result.isError).toBeFalsy();
      expect(createPipeline).toHaveBeenCalledWith("group/project", {
        ref: "main",
        inputs: {
          environment: "production",
          approvals_required: 2,
          dry_run: false,
          regions: ["cn", "us-east"]
        },
        variables: [{ key: "DEPLOY", value: "true" }]
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("allows createPipeline() with inputs only", async () => {
    const createPipeline = vi.fn().mockResolvedValue({
      id: 101,
      status: "pending"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createPipeline } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_pipeline",
        arguments: {
          project_id: "group/project",
          ref: "release",
          inputs: { environment: "staging" }
        }
      });

      expect(result.isError).toBeFalsy();
      expect(createPipeline).toHaveBeenCalledWith("group/project", {
        ref: "release",
        inputs: { environment: "staging" },
        variables: undefined
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Tag tools                                                          */
/* ------------------------------------------------------------------ */

describe("Tool handlers: tag tools", () => {
  it("passes filters to gitlab_list_tags", async () => {
    const listTags = vi.fn().mockResolvedValue([{ name: "v1.0.0" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listTags } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_tags",
        arguments: {
          project_id: "group/project",
          search: "^v",
          order_by: "version",
          sort: "desc",
          page: 2,
          per_page: 10
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listTags).toHaveBeenCalledWith("group/project", {
        query: expect.objectContaining({
          search: "^v",
          order_by: "version",
          sort: "desc",
          page: 2,
          per_page: 10
        })
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes tag name to gitlab_get_tag", async () => {
    const getTag = vi.fn().mockResolvedValue({ name: "release/v1" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getTag } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_tag",
        arguments: { project_id: "group/project", tag_name: "release/v1" }
      });

      expect(result.isError).toBeFalsy();
      expect(getTag).toHaveBeenCalledWith("group/project", "release/v1");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes payload to gitlab_create_tag", async () => {
    const createTag = vi.fn().mockResolvedValue({ name: "v1.0.0" });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createTag } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_create_tag",
        arguments: {
          project_id: "group/project",
          tag_name: "v1.0.0",
          ref: "main",
          message: "Release tag"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(createTag).toHaveBeenCalledWith("group/project", {
        tag_name: "v1.0.0",
        ref: "main",
        message: "Release tag"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes tag name to gitlab_delete_tag", async () => {
    const deleteTag = vi.fn().mockResolvedValue("");

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { deleteTag } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_delete_tag",
        arguments: { project_id: "group/project", tag_name: "release/v1" }
      });

      expect(result.isError).toBeFalsy();
      expect(deleteTag).toHaveBeenCalledWith("group/project", "release/v1");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes tag name to gitlab_get_tag_signature", async () => {
    const getTagSignature = vi.fn().mockResolvedValue({
      signature_type: "X509",
      verification_status: "verified"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getTagSignature } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_tag_signature",
        arguments: { project_id: "group/project", tag_name: "release/v1" }
      });

      expect(result.isError).toBeFalsy();
      expect(getTagSignature).toHaveBeenCalledWith("group/project", "release/v1");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Response structure                                                 */
/* ------------------------------------------------------------------ */

describe("Tool response structure", () => {
  it("returns content[0].text with formatted JSON and structuredContent with result + meta", async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 42,
      name: "my-project",
      path_with_namespace: "group/my-project"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/my-project" }
      });

      // content[0].text should be formatted JSON
      const textContent = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      );
      expect(textContent).toBeDefined();
      const parsed = JSON.parse(textContent!.text);
      expect(parsed.id).toBe(42);

      // structuredContent
      const structured = (result as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      expect(structured).toBeDefined();
      expect(structured!.result).toBeDefined();
      expect(structured!.meta).toBeDefined();

      const meta = structured!.meta as { truncated: boolean; bytes: number };
      expect(meta.truncated).toBe(false);
      expect(meta.bytes).toBeGreaterThan(0);
      expect(meta).not.toHaveProperty("pagination");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("exposes pagination only in structured meta after redaction and project filtering", async () => {
    const projects = attachPaginationMetadata(
      [
        {
          id: 1,
          path_with_namespace: "group/allowed",
          runners_token: "must-not-leak"
        },
        { id: 2, path_with_namespace: "group/blocked" }
      ],
      {
        page: 2,
        next_page: 3,
        per_page: 20,
        total: 40,
        total_pages: 2,
        links: { next: 3 }
      }
    );
    const listProjects = vi.fn().mockResolvedValue(projects);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/allowed"],
        gitlabStub: { listProjects }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: { page: 2, per_page: 20 }
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      const structured = result.structuredContent as {
        result?: { items?: Array<Record<string, unknown>> };
        meta?: { pagination?: Record<string, unknown> };
      };

      expect(JSON.parse(text)).toEqual([{ id: 1, path_with_namespace: "group/allowed" }]);
      expect(text).not.toContain("must-not-leak");
      expect(structured.result?.items).toEqual([{ id: 1, path_with_namespace: "group/allowed" }]);
      expect(structured.meta?.pagination).toEqual({
        page: 2,
        next_page: 3,
        per_page: 20
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  resolveProjectId with GITLAB_ALLOWED_PROJECT_IDS                   */
/* ------------------------------------------------------------------ */

describe("resolveProjectId with GITLAB_ALLOWED_PROJECT_IDS", () => {
  it("auto-resolves single allowed project when project_id is omitted", async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 1,
      name: "only-project"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/only-project"],
        gitlabStub: { getProject }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: {}
      });

      expect(result.isError).toBeFalsy();
      expect(getProject).toHaveBeenCalledWith("group/only-project");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects project_id not in allowed list", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/allowed-project"],
        gitlabStub: { getProject: vi.fn() }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "group/forbidden-project" }
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("not in GITLAB_ALLOWED_PROJECT_IDS");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects target and parent projects outside the allowed set", async () => {
    const createMergeRequest = vi.fn();
    const createIssueLink = vi.fn();
    const getProject = vi.fn();
    const executeGraphql = vi.fn();
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/allowed"],
        gitlabStub: { createMergeRequest, createIssueLink, getProject, executeGraphql }
      })
    );

    try {
      const calls = [
        {
          name: "gitlab_create_merge_request",
          arguments: {
            project_id: "group/allowed",
            target_project_id: "group/forbidden",
            source_branch: "feature",
            target_branch: "main",
            title: "Scoped MR"
          }
        },
        {
          name: "gitlab_create_issue_link",
          arguments: {
            project_id: "group/allowed",
            issue_iid: "1",
            target_project_id: "group/forbidden",
            target_issue_iid: "2"
          }
        },
        {
          name: "gitlab_update_work_item",
          arguments: {
            project_id: "group/allowed",
            iid: 1,
            parent_iid: 2,
            parent_project_id: "group/forbidden"
          }
        }
      ] as const;

      for (const call of calls) {
        const result = await client.callTool(call);
        expect(result.isError, call.name).toBe(true);
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
        expect(text, call.name).toContain("not in GITLAB_ALLOWED_PROJECT_IDS");
      }

      expect(createMergeRequest).not.toHaveBeenCalled();
      expect(createIssueLink).not.toHaveBeenCalled();
      expect(getProject).not.toHaveBeenCalled();
      expect(executeGraphql).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects forbidden project and all group forms for webhook tools", async () => {
    const listWebhooks = vi.fn();
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["group/allowed"],
        gitlabStub: { listWebhooks }
      })
    );

    try {
      const forbiddenProject = await client.callTool({
        name: "gitlab_list_webhooks",
        arguments: { project_id: "group/forbidden" }
      });
      const groupScope = await client.callTool({
        name: "gitlab_list_webhooks",
        arguments: { group_id: "group" }
      });

      expect(forbiddenProject.isError).toBe(true);
      expect(groupScope.isError).toBe(true);
      expect(listWebhooks).not.toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("filters global project and repository lists to allowed projects", async () => {
    const projects = [
      { id: 1, path_with_namespace: "group/by-id" },
      { id: 2, path_with_namespace: "group/by-path" },
      { id: 3, path_with_namespace: "group/forbidden" },
      { name: "missing-project-identity" }
    ];
    const listProjects = vi.fn().mockResolvedValue(projects);
    const searchRepositories = vi.fn().mockResolvedValue(projects);
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["1", "group/by-path"],
        gitlabStub: { listProjects, searchRepositories }
      })
    );

    try {
      for (const call of [
        { name: "gitlab_list_projects", arguments: {} },
        { name: "gitlab_search_repositories", arguments: { search: "group" } }
      ]) {
        const result = await client.callTool(call);
        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as {
          result?: { items?: Array<Record<string, unknown>>; count?: number };
        };
        expect(structured.result?.items).toEqual(projects.slice(0, 2));
        expect(structured.result?.count).toBe(2);
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("runs global code search separately for each allowed project", async () => {
    const searchCode = vi.fn();
    const searchCodeBlobs = vi.fn().mockImplementation((projectId: string) =>
      Promise.resolve(
        attachPaginationMetadata([{ project_id: projectId, path: `${projectId}/file.ts` }], {
          page: 1,
          next_page: 2,
          total: 10
        })
      )
    );
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["1", "group/project"],
        gitlabStub: { searchCode, searchCodeBlobs }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_search_code",
        arguments: { search: "needle", filename: "file.ts" }
      });

      expect(result.isError).toBeFalsy();
      expect(searchCode).not.toHaveBeenCalled();
      expect(searchCodeBlobs).toHaveBeenCalledTimes(2);
      expect(searchCodeBlobs).toHaveBeenCalledWith(
        "1",
        "needle",
        expect.objectContaining({ query: expect.objectContaining({ filename: "file.ts" }) })
      );
      expect(searchCodeBlobs).toHaveBeenCalledWith(
        "group/project",
        "needle",
        expect.objectContaining({ query: expect.objectContaining({ filename: "file.ts" }) })
      );
      expect(
        (result.structuredContent as { meta?: Record<string, unknown> }).meta
      ).not.toHaveProperty("pagination");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("filters todos and verifies ownership before marking one done", async () => {
    const todos = [
      { id: 7, project: { id: 1, path_with_namespace: "group/allowed" } },
      { id: 8, project: { id: 2, path_with_namespace: "group/forbidden" } },
      { id: 9, target: { project_id: 2 } },
      { id: 1, project: { id: 2, path_with_namespace: "group/forbidden" } }
    ];
    const listTodos = vi.fn().mockResolvedValue(todos);
    const markTodoDone = vi.fn().mockResolvedValue({ id: 7, state: "done" });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        allowedProjectIds: ["1"],
        gitlabStub: { listTodos, markTodoDone }
      })
    );

    try {
      const listed = await client.callTool({ name: "gitlab_list_todos", arguments: {} });
      const listedContent = listed.structuredContent as {
        result?: { items?: Array<Record<string, unknown>>; count?: number };
      };
      expect(listedContent.result?.items).toEqual([todos[0]]);
      expect(listedContent.result?.count).toBe(1);

      const allowed = await client.callTool({
        name: "gitlab_mark_todo_done",
        arguments: { todo_id: "7" }
      });
      const forbidden = await client.callTool({
        name: "gitlab_mark_todo_done",
        arguments: { todo_id: "8" }
      });
      const collidingId = await client.callTool({
        name: "gitlab_mark_todo_done",
        arguments: { todo_id: "1" }
      });

      expect(allowed.isError).toBeFalsy();
      expect(forbidden.isError).toBe(true);
      expect(collidingId.isError).toBe(true);
      expect(markTodoDone).toHaveBeenCalledTimes(1);
      expect(markTodoDone).toHaveBeenCalledWith("7");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  assertAuthReady with no token                                      */
/* ------------------------------------------------------------------ */

describe("assertAuthReady with no token", () => {
  it("returns isError: true with 'Authentication required'", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ token: null })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "test/project" }
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("Authentication required");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("accepts MCP OAuth session tokens without static fallback auth", async () => {
    const getProject = vi.fn().mockResolvedValue({
      id: 42,
      name: "oauth-project",
      path_with_namespace: "group/oauth-project"
    });
    const context = buildContext({ token: null, gitlabStub: { getProject } });
    context.env.GITLAB_MCP_OAUTH = true;
    context.env.MCP_SERVER_URL = "https://mcp.example.com";

    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await runWithSessionAuth(
        {
          token: "oauth-session-token",
          header: "authorization",
          updatedAt: Date.now()
        },
        () =>
          client.callTool({
            name: "gitlab_get_project",
            arguments: { project_id: "group/oauth-project" }
          })
      );

      expect(result.isError).toBeFalsy();
      expect(getProject).toHaveBeenCalledWith("group/oauth-project");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Pipeline artifact and deployment tools                             */
/* ------------------------------------------------------------------ */

describe("Tool handler: pipeline deployment and artifact tools", () => {
  it("hides local artifact download tools in read-only mode", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true })
    );

    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toContain("gitlab_download_job_artifacts");
      expect(names).not.toContain("gitlab_download_job_artifacts_local");
      expect(names).toContain("gitlab_get_job_artifact_file");
      expect(names).not.toContain("gitlab_get_job_artifact_file_local");
      expect(names).toContain("gitlab_get_job_artifact_file");
      expect(names).toContain("gitlab_list_job_artifacts");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("passes filters through to gitlab_list_deployments", async () => {
    const listDeployments = vi.fn().mockResolvedValue([{ id: 1, environment: { name: "prod" } }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listDeployments } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_deployments",
        arguments: {
          project_id: "group/project",
          environment: "prod",
          status: "success",
          page: 2
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listDeployments).toHaveBeenCalledWith("group/project", {
        query: {
          environment: "prod",
          status: "success",
          page: 2
        }
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns inline archive content from gitlab_download_job_artifacts", async () => {
    const downloadJobArtifacts = vi.fn().mockResolvedValue({
      fileName: "artifacts-job-42.zip",
      contentType: "application/zip",
      base64: "UEsDBA=="
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { downloadJobArtifacts } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_download_job_artifacts",
        arguments: {
          project_id: "group/project",
          job_id: "42"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(downloadJobArtifacts).toHaveBeenCalledWith("group/project", "42");

      const structured = (result as { structuredContent?: { result?: unknown } }).structuredContent;
      expect(structured?.result).toEqual({
        fileName: "artifacts-job-42.zip",
        contentType: "application/zip",
        base64: "UEsDBA=="
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns saved archive metadata from gitlab_download_job_artifacts_local", async () => {
    const saveJobArtifacts = vi.fn().mockResolvedValue({
      filePath: "/tmp/artifacts-job-42.zip",
      fileName: "artifacts-job-42.zip",
      contentType: "application/zip",
      size: 7
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { saveJobArtifacts } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_download_job_artifacts_local",
        arguments: {
          project_id: "group/project",
          job_id: "42"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(saveJobArtifacts).toHaveBeenCalledWith("group/project", "42", undefined);

      const structured = (result as { structuredContent?: { result?: unknown } }).structuredContent;
      expect(structured?.result).toEqual({
        filePath: "/tmp/artifacts-job-42.zip",
        fileName: "artifacts-job-42.zip",
        contentType: "application/zip",
        size: 7
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns inline artifact content from gitlab_get_job_artifact_file", async () => {
    const getJobArtifactFile = vi.fn().mockResolvedValue({
      fileName: "summary.txt",
      contentType: "text/plain",
      encoding: "utf8",
      content: "ok"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getJobArtifactFile } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_job_artifact_file",
        arguments: {
          project_id: "group/project",
          job_id: "99",
          artifact_path: "reports/summary.txt",
          inline: true
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getJobArtifactFile).toHaveBeenCalledWith("group/project", "99", "reports/summary.txt");

      const structured = (result as { structuredContent?: { result?: unknown } }).structuredContent;
      expect(structured?.result).toEqual({
        fileName: "summary.txt",
        contentType: "text/plain",
        encoding: "utf8",
        content: "ok"
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("saves artifact files locally with gitlab_get_job_artifact_file_local", async () => {
    const saveJobArtifactFile = vi.fn().mockResolvedValue({
      filePath: "/tmp/summary.txt",
      fileName: "summary.txt",
      contentType: "text/plain",
      size: 2
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { saveJobArtifactFile } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_job_artifact_file_local",
        arguments: {
          project_id: "group/project",
          job_id: "99",
          artifact_path: "reports/summary.txt"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(saveJobArtifactFile).toHaveBeenCalledWith(
        "group/project",
        "99",
        "reports/summary.txt",
        undefined
      );

      const structured = (result as { structuredContent?: { result?: unknown } }).structuredContent;
      expect(structured?.result).toEqual({
        filePath: "/tmp/summary.txt",
        fileName: "summary.txt",
        contentType: "text/plain",
        size: 2
      });
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("returns inline artifact content through the read-only-safe tool", async () => {
    const getJobArtifactFile = vi.fn().mockResolvedValue({
      fileName: "summary.txt",
      contentType: "text/plain",
      encoding: "utf8",
      content: "ok"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ readOnlyMode: true, gitlabStub: { getJobArtifactFile } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_job_artifact_file",
        arguments: {
          project_id: "group/project",
          job_id: "99",
          artifact_path: "reports/summary.txt"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(getJobArtifactFile).toHaveBeenCalledWith("group/project", "99", "reports/summary.txt");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Output truncation                                                  */
/* ------------------------------------------------------------------ */

describe("Output truncation", () => {
  it("sets meta.truncated: true when output exceeds maxBytes", async () => {
    const largeData = { data: "x".repeat(500) };
    const getProject = vi.fn().mockResolvedValue(largeData);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ maxBytes: 50, gitlabStub: { getProject } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "test/project" }
      });

      expect(result.isError).toBeFalsy();

      const structured = (result as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      expect(structured).toBeDefined();

      const meta = structured!.meta as { truncated: boolean; bytes: number };
      expect(meta.truncated).toBe(true);
      expect(meta.bytes).toBeGreaterThan(50);
      expect(structured!.result).toEqual({ truncated: true });

      // The text should contain the truncation marker
      const text = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      )!.text;
      expect(text).toContain("truncated");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
