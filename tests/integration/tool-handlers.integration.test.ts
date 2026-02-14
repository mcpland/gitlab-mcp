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
