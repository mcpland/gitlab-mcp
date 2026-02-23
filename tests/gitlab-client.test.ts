import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { GitLabApiError, GitLabClient, getEffectiveSessionAuth } from "../src/lib/gitlab-client.js";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" }
  });
}

function textResponse(text: string, status = 200) {
  return new Response(text, {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "text/plain" }
  });
}

describe("GitLabClient", () => {
  describe("authentication", () => {
    it("sends private token header when token is provided", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1, name: "demo" }));

      const client = new GitLabClient("https://gitlab.example.com", "token-123");
      await client.getProject("group/demo");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];

      expect(String(requestUrl)).toContain("/api/v4/projects/group%2Fdemo");
      expect(new Headers(init.headers).get("PRIVATE-TOKEN")).toBe("token-123");
    });

    it("does not send private token header when no token is provided", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.listProjects();

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(new Headers(init.headers).has("PRIVATE-TOKEN")).toBe(false);
    });

    it("uses token from request options over default token", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "default-token");
      await client.getProject("p1", { token: "override-token" });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(new Headers(init.headers).get("PRIVATE-TOKEN")).toBe("override-token");
    });
  });

  describe("error handling", () => {
    it("throws GitLabApiError for non-2xx responses", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: "404 Project Not Found" }, 404));

      const client = new GitLabClient("https://gitlab.example.com", "token-123");
      const error = await client.getProject("missing/project").catch((reason) => reason);

      expect(error).toBeInstanceOf(GitLabApiError);
      expect(error).toMatchObject({ status: 404 });
    });

    it("includes error details from JSON response", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ message: "Forbidden", error_description: "scope required" }, 403)
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const error = (await client.getProject("p1").catch((reason) => reason)) as GitLabApiError;

      expect(error.status).toBe(403);
      expect(error.details).toEqual({ message: "Forbidden", error_description: "scope required" });
    });

    it("handles text error responses", async () => {
      fetchMock.mockResolvedValue(textResponse("Server Error", 500));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const error = (await client.getProject("p1").catch((reason) => reason)) as GitLabApiError;

      expect(error.status).toBe(500);
      expect(error.details).toBe("Server Error");
    });

    it("GitLabApiError has correct name", () => {
      const error = new GitLabApiError("test", 400, { info: "details" });
      expect(error.name).toBe("GitLabApiError");
      expect(error.message).toBe("test");
      expect(error.status).toBe(400);
      expect(error.details).toEqual({ info: "details" });
    });
  });

  describe("URL normalization", () => {
    it("normalizes base URL to include /api/v4", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.listProjects();

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("https://gitlab.example.com/api/v4/projects");
    });

    it("does not double-add /api/v4 when already present", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com/api/v4");
      await client.listProjects();

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const urlStr = String(requestUrl);
      expect(urlStr).toContain("/api/v4/projects");
      expect(urlStr).not.toContain("/api/v4/api/v4");
    });

    it("handles trailing slash in base URL", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com/api/v4/");
      await client.listProjects();

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/api/v4/projects");
    });

    it("handles subpath GitLab installations", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://company.com/gitlab");
      await client.listProjects();

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/gitlab/api/v4/projects");
    });
  });

  describe("query parameters", () => {
    it("adds query params for project search", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.searchProjects("backend", 7);

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));

      expect(url.pathname).toBe("/api/v4/projects");
      expect(url.searchParams.get("search")).toBe("backend");
      expect(url.searchParams.get("simple")).toBe("true");
      expect(url.searchParams.get("per_page")).toBe("7");
    });

    it("skips null and undefined query parameters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.listProjects({ query: { key: "val", empty: undefined, nil: null } });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));

      expect(url.searchParams.get("key")).toBe("val");
      expect(url.searchParams.has("empty")).toBe(false);
      expect(url.searchParams.has("nil")).toBe(false);
    });
  });

  describe("HTTP methods", () => {
    it("uses GET for read methods", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listProjects();

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(init.method).toBe("GET");
    });

    it("uses POST for create methods", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createIssue("proj", { title: "Bug" });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(init.method).toBe("POST");
    });

    it("uses PUT for update methods", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.updateIssue("proj", "1", { title: "Updated" });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(init.method).toBe("PUT");
    });

    it("uses DELETE for delete methods", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.deleteIssue("proj", "1");

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(init.method).toBe("DELETE");
    });
  });

  describe("global endpoints", () => {
    it("supports global merge request listing endpoint", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.listGlobalMergeRequests({
        query: { state: "opened", per_page: 5 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toBe("/api/v4/merge_requests");
      expect(url.searchParams.get("state")).toBe("opened");
      expect(url.searchParams.get("per_page")).toBe("5");
    });

    it("supports global issue listing endpoint", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.listGlobalIssues({
        query: { scope: "assigned_to_me", page: 2 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toBe("/api/v4/issues");
      expect(url.searchParams.get("scope")).toBe("assigned_to_me");
      expect(url.searchParams.get("page")).toBe("2");
    });
  });

  describe("attachment downloads", () => {
    it("rejects cross-origin attachment URLs", async () => {
      const client = new GitLabClient("https://gitlab.example.com", "token-123");

      const error = await client
        .downloadAttachment("https://evil.example.net/uploads/secret/file.txt")
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("cross-origin");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows same-origin attachment URLs", async () => {
      fetchMock.mockResolvedValue(
        new Response("hello", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="hello.txt"'
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token-123");
      const result = await client.downloadAttachment(
        "https://gitlab.example.com/uploads/secret/hello.txt"
      );

      expect(result.fileName).toBe("hello.txt");
      expect(result.contentType).toBe("text/plain");
      expect(Buffer.from(result.base64, "base64").toString("utf8")).toBe("hello");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("applies beforeRequest token overrides to attachment downloads", async () => {
      fetchMock.mockResolvedValue(
        new Response("ok", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="ok.txt"'
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", undefined, {
        beforeRequest: async () => ({ token: "token-from-hook" })
      });

      await client.downloadAttachment("https://gitlab.example.com/uploads/secret/ok.txt");

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(new Headers(init.headers).get("PRIVATE-TOKEN")).toBe("token-from-hook");
    });

    it("handles relative attachment URLs", async () => {
      fetchMock.mockResolvedValue(
        new Response("data", {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="data.bin"'
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.downloadAttachment("/uploads/secret/data.bin");

      expect(result.fileName).toBe("data.bin");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("returns fallback filename when content-disposition is missing", async () => {
      fetchMock.mockResolvedValue(
        new Response("data", {
          status: 200,
          headers: { "content-type": "application/octet-stream" }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.downloadAttachment(
        "https://gitlab.example.com/uploads/abc/file.bin"
      );

      expect(result.fileName).toContain("attachment-");
    });

    it("throws GitLabApiError for failed attachment download", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const error = await client
        .downloadAttachment("https://gitlab.example.com/uploads/abc/file.txt")
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(GitLabApiError);
      expect((error as GitLabApiError).status).toBe(404);
    });

    it("rejects attachment when content-length exceeds configured limit", async () => {
      fetchMock.mockResolvedValue(
        new Response("ignored", {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="too-large.bin"',
            "content-length": "9"
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxAttachmentBytes: 8
      });
      const error = await client
        .downloadAttachment("https://gitlab.example.com/uploads/abc/too-large.bin")
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exceeds limit");
    });

    it("rejects attachment when streamed body exceeds configured limit", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
          controller.enqueue(new TextEncoder().encode("67890"));
          controller.close();
        }
      });
      fetchMock.mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="stream.bin"'
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxAttachmentBytes: 9
      });
      const error = await client
        .downloadAttachment("https://gitlab.example.com/uploads/abc/stream.bin")
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exceeds limit");
    });
  });

  describe("beforeRequest hook", () => {
    it("allows overriding headers", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const customHeaders = new Headers();
      customHeaders.set("X-Custom", "value");
      customHeaders.set("Accept", "application/json");

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        beforeRequest: async () => ({ headers: customHeaders })
      });

      await client.listProjects();

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("X-Custom")).toBe("value");
    });

    it("allows overriding token", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "original-token", {
        beforeRequest: async () => ({ token: "dynamic-token" })
      });

      await client.listProjects();

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(new Headers(init.headers).get("PRIVATE-TOKEN")).toBe("dynamic-token");
    });

    it("allows overriding fetch implementation", async () => {
      const customFetch = vi.fn().mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        beforeRequest: async () => ({ fetchImpl: customFetch as typeof fetch })
      });

      await client.listProjects();

      expect(customFetch).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("API URL round-robin", () => {
    it("rotates through multiple API URLs", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]));

      const client = new GitLabClient("https://primary.example.com", "token", {
        apiUrls: ["https://a.example.com/api/v4", "https://b.example.com/api/v4"]
      });

      await client.listProjects();
      await client.listProjects();
      await client.listProjects();

      const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])).origin);

      expect(urls[0]).toBe("https://a.example.com");
      expect(urls[1]).toBe("https://b.example.com");
      expect(urls[2]).toBe("https://a.example.com");
    });

    it("uses base URL when no apiUrls provided", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listProjects();

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("gitlab.example.com");
    });
  });

  describe("GraphQL", () => {
    it("sends GraphQL requests to the graphql endpoint", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: {} }));

      const client = new GitLabClient("https://gitlab.example.com/api/v4", "token");
      await client.executeGraphql("query { currentUser { id } }", undefined);

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const url = new URL(String(requestUrl));

      expect(url.pathname).toContain("graphql");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.query).toBe("query { currentUser { id } }");
    });

    it("includes variables in GraphQL request", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: {} }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.executeGraphql("query ($id: ID!) { project(id: $id) { name } }", {
        id: "gid://gitlab/Project/1"
      });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const body = JSON.parse(init.body as string);

      expect(body.variables).toEqual({ id: "gid://gitlab/Project/1" });
    });
  });

  describe("specific API methods", () => {
    it("encodes project ID in URLs", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getProject("group/subgroup/project");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("group%2Fsubgroup%2Fproject");
    });

    it("creates merge request with correct payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ iid: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createMergeRequest("proj", {
        source_branch: "feature",
        target_branch: "main",
        title: "My MR",
        description: "Description"
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(String(requestUrl)).toContain("/merge_requests");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.source_branch).toBe("feature");
      expect(body.target_branch).toBe("main");
      expect(body.title).toBe("My MR");
    });

    it("creates branch with query parameters", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ name: "new-branch" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createBranch("proj", { branch: "new-branch", ref: "main" });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.searchParams.get("branch")).toBe("new-branch");
      expect(url.searchParams.get("ref")).toBe("main");
    });

    it("gets file contents with ref", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ content: "aGVsbG8=", encoding: "base64" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getFileContents("proj", "src/index.ts", "main");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/repository/files/src%2Findex.ts");
      expect(url.searchParams.get("ref")).toBe("main");
    });

    it("uploads markdown file", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ markdown: "![file](/uploads/abc/file.md)" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.uploadMarkdown("proj", "# Hello", "readme.md");

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
    });

    it("creates pipeline with variables", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createPipeline("proj", {
        ref: "main",
        variables: [{ key: "ENV", value: "production" }]
      });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.ref).toBe("main");
      expect(body.variables).toEqual([{ key: "ENV", value: "production" }]);
    });

    it("gets commit diff", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getCommitDiff("proj", "abc123");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/commits/abc123/diff");
    });

    it("creates issue note with discussion_id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createIssueNote("proj", "5", {
        body: "Comment",
        discussion_id: "disc-1"
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/discussions/disc-1/notes");
    });

    it("creates issue note without discussion_id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createIssueNote("proj", "5", { body: "Comment" });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/issues/5/notes");
      expect(String(requestUrl)).not.toContain("/discussions/");
    });

    it("draft note creation maps body to note field", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createDraftNote("proj", "1", { body: "draft content" });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.note).toBe("draft content");
    });

    it("myIssues uses correct path with project_id", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.myIssues({ project_id: "my/proj", state: "opened" });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/projects/my%2Fproj/issues");
    });

    it("myIssues uses global path without project_id", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.myIssues({ state: "opened" });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toBe("/api/v4/issues");
      expect(url.searchParams.get("scope")).toBe("assigned_to_me");
    });

    it("releases use encoded tag names", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getRelease("proj", "v1.0.0");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/releases/v1.0.0");
    });

    it("downloadReleaseAsset encodes path segments", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.downloadReleaseAsset("proj", "v1.0", "bin/my app.tar.gz");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const urlStr = String(requestUrl);
      expect(urlStr).toContain("/downloads/bin/my%20app.tar.gz");
    });

    it("deleteLabel uses query param for label name", async () => {
      fetchMock.mockResolvedValue(jsonResponse(null));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.deleteLabel("proj", "bug");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.searchParams.get("name")).toBe("bug");
    });
  });

  describe("getEffectiveSessionAuth", () => {
    it("returns defaults when no session auth is available", () => {
      const result = getEffectiveSessionAuth("fallback-token", "https://gitlab.example.com");

      expect(result.token).toBe("fallback-token");
      expect(result.apiUrl).toBe("https://gitlab.example.com");
      expect(result.updatedAt).toBeDefined();
    });

    it("returns undefined token when no defaults", () => {
      const result = getEffectiveSessionAuth();

      expect(result.token).toBeUndefined();
      expect(result.apiUrl).toBeUndefined();
    });
  });
});
