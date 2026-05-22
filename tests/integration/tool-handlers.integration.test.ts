/**
 * Integration tests for individual tool handlers.
 *
 * Each test calls a tool through the full MCP protocol (client.callTool)
 * with a mocked GitLabClient, then verifies:
 *   - The correct client method was invoked with expected arguments
 *   - The response structure (content + structuredContent) is correct
 */
import { describe, expect, it, vi } from "vitest";

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
        arguments: { search: "test", page: 2, per_page: 10 }
      });

      expect(result.isError).toBeFalsy();
      expect(listProjects).toHaveBeenCalledWith({
        query: expect.objectContaining({
          search: "test",
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
/*  gitlab_get_merge_request                                           */
/* ------------------------------------------------------------------ */

describe("Tool handler: gitlab_get_merge_request", () => {
  it("passes project_id + merge_request_iid to getMergeRequest()", async () => {
    const getMergeRequest = vi.fn().mockResolvedValue({
      iid: 7,
      title: "Add feature",
      state: "opened"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getMergeRequest } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_merge_request",
        arguments: { project_id: "group/project", merge_request_iid: "7" }
      });

      expect(result.isError).toBeFalsy();
      expect(getMergeRequest).toHaveBeenCalledWith("group/project", "7");
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
