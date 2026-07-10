import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { GitLabApiError, GitLabClient, getEffectiveSessionAuth } from "../src/lib/gitlab-client.js";
import { runWithSessionAuth } from "../src/lib/auth-context.js";
import { getPaginationMetadata } from "../src/lib/pagination.js";

const fetchMock = vi.fn();
const tempDirs: string[] = [];

vi.stubGlobal("fetch", fetchMock);

afterEach(async () => {
  vi.useRealTimers();
  fetchMock.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }

  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: responseHeaders
  });
}

function textResponse(text: string, status = 200) {
  return new Response(text, {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "text/plain" }
  });
}

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

    it("attaches GitLab pagination headers without changing the response shape", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([{ id: 1 }], 200, {
          "X-Page": "2",
          "X-Next-Page": "3",
          "X-Prev-Page": "1",
          "X-Per-Page": "20",
          "X-Total": "81",
          "X-Total-Pages": "5",
          Link: '<https://token:secret@gitlab.example.com/api/v4/projects?page=3&private_token=hidden>; rel="next"'
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.listProjects({ query: { page: 2, per_page: 20 } });

      expect(JSON.stringify(result)).toBe('[{"id":1}]');
      expect(getPaginationMetadata(result)).toEqual({
        page: 2,
        next_page: 3,
        prev_page: 1,
        per_page: 20,
        total: 81,
        total_pages: 5,
        links: { next: 3 }
      });
    });

    it("uses token from request options over default token", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

      const client = new GitLabClient("https://gitlab.example.com", "default-token");
      await client.getProject("p1", { token: "override-token" });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(new Headers(init.headers).get("PRIVATE-TOKEN")).toBe("override-token");
    });

    it("uses authorization header when session auth indicates bearer mode", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await runWithSessionAuth(
        {
          token: "bearer-token",
          apiUrl: "https://gitlab.example.com/api/v4",
          header: "authorization",
          updatedAt: Date.now()
        },
        async () => {
          await client.listProjects();
        }
      );

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer bearer-token");
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
    });

    it("uses job-token header when session auth indicates CI job token mode", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await runWithSessionAuth(
        {
          token: "job-token-123",
          apiUrl: "https://gitlab.example.com/api/v4",
          header: "job-token",
          updatedAt: Date.now()
        },
        async () => {
          await client.listProjects();
        }
      );

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("JOB-TOKEN")).toBe("job-token-123");
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
      expect(headers.has("Authorization")).toBe(false);
    });

    it("uses job-token header when configured as the default auth header", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "job-token-123", {
        defaultAuthHeader: "job-token"
      });
      await client.listProjects();

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("JOB-TOKEN")).toBe("job-token-123");
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
      expect(headers.has("Authorization")).toBe(false);
    });

    it("lets explicit request auth override the default job-token auth header", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "job-token-123", {
        defaultAuthHeader: "job-token"
      });
      await client.listProjects({
        token: "pat-token-123",
        authHeader: "private-token"
      });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("PRIVATE-TOKEN")).toBe("pat-token-123");
      expect(headers.has("JOB-TOKEN")).toBe(false);
      expect(headers.has("Authorization")).toBe(false);
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

    it("preserves GitLabApiError on oversized non-2xx response bodies", async () => {
      fetchMock.mockResolvedValue(
        new Response("123456789", {
          status: 500,
          statusText: "Internal Server Error",
          headers: {
            "content-type": "text/plain",
            "content-length": "9"
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxResponseBodyBytes: 8
      });
      const error = await client.listProjects().catch((reason) => reason);

      expect(error).toBeInstanceOf(GitLabApiError);
      expect((error as GitLabApiError).status).toBe(500);
      expect((error as GitLabApiError).details).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("exceeds limit")
        })
      );
    });
  });

  describe("idempotent GET retries", () => {
    it.each([429, 502, 503, 504])("retries GET responses with status %s", async (status) => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: "temporary" }, status))
        .mockResolvedValueOnce(jsonResponse({ id: 1, name: "recovered" }));
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxGetRetries: 1,
        getRetryBaseDelayMs: 0
      });

      await expect(client.getProject("proj")).resolves.toMatchObject({ name: "recovered" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("honors Retry-After before retrying", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: "slow down" }, 429, { "Retry-After": "1" }))
        .mockResolvedValueOnce(jsonResponse({ id: 1 }));
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxGetRetries: 1,
        getRetryBaseDelayMs: 0,
        getRetryMaxDelayMs: 2_000
      });

      const resultPromise = client.getProject("proj");
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(resultPromise).resolves.toMatchObject({ id: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry when Retry-After exceeds the configured maximum", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ message: "slow down" }, 429, { "Retry-After": "2" })
      );
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxGetRetries: 2,
        getRetryBaseDelayMs: 0,
        getRetryMaxDelayMs: 1_000
      });

      await expect(client.getProject("proj")).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stops after the configured number of retries", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ message: "unavailable" }, 503));
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxGetRetries: 2,
        getRetryBaseDelayMs: 0
      });

      await expect(client.getProject("proj")).rejects.toMatchObject({ status: 503 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("never retries mutations", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 503))
        .mockResolvedValueOnce(jsonResponse({ id: 1 }));
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxGetRetries: 2,
        getRetryBaseDelayMs: 0
      });

      await expect(client.createRepository({ name: "demo" })).rejects.toMatchObject({
        status: 503
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("response size limits", () => {
    it("rejects responses when declared content-length exceeds configured limit", async () => {
      fetchMock.mockResolvedValue(
        new Response("123456789", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": "9"
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxResponseBodyBytes: 8
      });
      const error = await client.listProjects().catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Response body size");
    });

    it("rejects responses when streamed bytes exceed configured limit", async () => {
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
            "content-type": "text/plain"
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxResponseBodyBytes: 9
      });
      const error = await client.listProjects().catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Response body size");
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

    it("creates groups with JSON payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1, name: "Team" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createGroup({
        name: "Team",
        path: "team",
        description: "Team group",
        visibility: "private",
        parent_id: 42
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body as string);

      expect(new URL(String(requestUrl)).pathname).toBe("/api/v4/groups");
      expect(init.method).toBe("POST");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(body).toEqual({
        name: "Team",
        path: "team",
        description: "Team group",
        visibility: "private",
        parent_id: 42
      });
    });

    it("searches code globally with filters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.searchCode("logger", {
        query: { filename: "*.ts", path: "src/*", extension: "ts", page: 2 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));

      expect(url.pathname).toBe("/api/v4/search");
      expect(url.searchParams.get("scope")).toBe("blobs");
      expect(url.searchParams.get("search")).toBe("logger");
      expect(url.searchParams.get("filename")).toBe("*.ts");
      expect(url.searchParams.get("path")).toBe("src/*");
      expect(url.searchParams.get("extension")).toBe("ts");
      expect(url.searchParams.get("page")).toBe("2");
    });

    it("searches code in projects and groups", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.searchCodeBlobs("group/project", "logger", { query: { ref: "main" } });
      await client.searchGroupCodeBlobs("parent/group", "logger", { query: { per_page: 5 } });

      const [projectUrl] = fetchMock.mock.calls[0] as [URL | string];
      const [groupUrl] = fetchMock.mock.calls[1] as [URL | string];
      const project = new URL(String(projectUrl));
      const group = new URL(String(groupUrl));

      expect(project.pathname).toContain("/projects/group%2Fproject/search");
      expect(project.searchParams.get("scope")).toBe("blobs");
      expect(project.searchParams.get("ref")).toBe("main");
      expect(group.pathname).toContain("/groups/parent%2Fgroup/search");
      expect(group.searchParams.get("scope")).toBe("blobs");
      expect(group.searchParams.get("per_page")).toBe("5");
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
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));

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

    it("serializes array query values using GitLab bracket parameters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.listGlobalMergeRequests({
        query: { approved_by_usernames: ["alice", "bob"] }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.searchParams.getAll("approved_by_usernames[]")).toEqual(["alice", "bob"]);
      expect(url.searchParams.has("approved_by_usernames")).toBe(false);
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

    it("verifies a namespace within an optional parent", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ exists: true }));

      const client = new GitLabClient("https://gitlab.example.com");
      await client.verifyNamespace("platform", { query: { parent_id: 42 } });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toBe("/api/v4/namespaces/platform/exists");
      expect(url.searchParams.get("parent_id")).toBe("42");
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

    it("rejects same-origin non-upload URLs", async () => {
      const client = new GitLabClient("https://gitlab.example.com", "token-123");

      const error = await client
        .downloadAttachment("https://gitlab.example.com/api/v4/projects")
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("non-upload");
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

    it("allows overriding auth header mode", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", undefined, {
        beforeRequest: async () => ({ token: "oauth-token", authHeader: "authorization" })
      });

      await client.listProjects();

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("Authorization")).toBe("Bearer oauth-token");
      expect(headers.has("PRIVATE-TOKEN")).toBe(false);
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

      expect(url.host).toBe("gitlab.example.com");
      expect(url.pathname).toBe("/api/graphql");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.query).toBe("query { currentUser { id } }");
    });

    it.each([
      ["https://gitlab.com/api/v4", "gitlab.com", "/api/graphql"],
      ["https://gitlab.com/api/v4/", "gitlab.com", "/api/graphql"],
      ["https://gitlab.com", "gitlab.com", "/api/graphql"],
      ["https://gitlab.example.com/gitlab/api/v4", "gitlab.example.com", "/gitlab/api/graphql"]
    ])("builds graphql endpoint correctly for %s", async (apiUrl, expectedHost, expectedPath) => {
      fetchMock.mockResolvedValue(jsonResponse({ data: {} }));

      const client = new GitLabClient(apiUrl, "token");
      await client.executeGraphql("query { currentUser { id } }", undefined);

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const url = new URL(String(requestUrl));

      expect(url.host).toBe(expectedHost);
      expect(url.pathname).toBe(expectedPath);
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
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getProject("group/subgroup/project");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("group%2Fsubgroup%2Fproject");
    });

    it("canonicalizes pre-encoded project paths across settings and webhook endpoints", async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const projectId = "group%2Fproject";
      for (const request of [
        () => client.updateProject(projectId, { description: "updated" }),
        () => client.listProtectedBranches(projectId),
        () => client.getProtectedBranch(projectId, "main"),
        () => client.protectBranch(projectId, { name: "main" }),
        () => client.unprotectBranch(projectId, "main"),
        () => client.updateDefaultBranch(projectId, "main"),
        () => client.listWebhooks({ projectId })
      ]) {
        await request();
      }

      const paths = fetchMock.mock.calls.map(
        ([requestUrl]) => new URL(String(requestUrl)).pathname
      );
      expect(paths).toHaveLength(7);
      for (const requestPath of paths) {
        expect(requestPath).toContain("/projects/group%2Fproject");
        expect(requestPath).not.toContain("%252F");
      }
    });

    it("canonicalizes pre-encoded group paths across group endpoint families", async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const groupId = "group%2Fsubgroup";
      for (const request of [
        () => client.listGroupProjects(groupId),
        () => client.getGroup(groupId),
        () => client.listGroupVariables(groupId),
        () => client.getGroupVariable(groupId, "TOKEN"),
        () => client.createGroupVariable(groupId, { key: "TOKEN", value: "secret" }),
        () => client.updateGroupVariable(groupId, "TOKEN", { value: "secret" }),
        () => client.deleteGroupVariable(groupId, "TOKEN"),
        () => client.purgeDependencyProxyCache(groupId),
        () => client.searchGroupCodeBlobs(groupId, "needle"),
        () => client.listGroupWikiPages(groupId),
        () => client.getGroupWikiPage(groupId, "home"),
        () => client.createGroupWikiPage(groupId, { title: "Home", content: "body" }),
        () => client.updateGroupWikiPage(groupId, "home", { content: "updated" }),
        () => client.deleteGroupWikiPage(groupId, "home"),
        () => client.listGroupIterations(groupId),
        () => client.listWebhooks({ groupId })
      ]) {
        await request();
      }

      const paths = fetchMock.mock.calls.map(
        ([requestUrl]) => new URL(String(requestUrl)).pathname
      );
      expect(paths).toHaveLength(16);
      for (const requestPath of paths) {
        expect(requestPath).toContain("/groups/group%2Fsubgroup");
        expect(requestPath).not.toContain("%252F");
      }
    });

    it("updates a project with only the supplied allowlisted payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 1, visibility: "internal" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.updateProject("group/project", {
        description: "Updated project",
        visibility: "internal",
        topics: ["mcp", "gitlab"],
        only_allow_merge_if_pipeline_succeeds: true,
        issues_access_level: "private"
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(String(requestUrl)).toContain("/projects/group%2Fproject");
      expect(init.method).toBe("PUT");
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({
        description: "Updated project",
        visibility: "internal",
        topics: ["mcp", "gitlab"],
        only_allow_merge_if_pipeline_succeeds: true,
        issues_access_level: "private"
      });
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

    it("lists branches with filters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ name: "main" }]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listBranches("proj", {
        query: { search: "release", per_page: 20 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/repository/branches");
      expect(url.searchParams.get("search")).toBe("release");
      expect(url.searchParams.get("per_page")).toBe("20");
    });

    it("gets and deletes branches with encoded names", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ name: "feature/a" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getBranch("proj", "feature/a");
      await client.deleteBranch("proj", "feature/a");

      const [getUrl] = fetchMock.mock.calls[0] as [URL | string];
      const [, deleteInit] = fetchMock.mock.calls[1] as [URL | string, RequestInit];

      expect(String(getUrl)).toContain("/projects/proj/repository/branches/feature%2Fa");
      expect(deleteInit.method).toBe("DELETE");
    });

    it("lists protected branches with search and pagination", async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ name: "release/*" }]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listProtectedBranches("group/project", {
        query: { search: "release", page: 2, per_page: 50 }
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/group%2Fproject/protected_branches");
      expect(url.searchParams.get("search")).toBe("release");
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("per_page")).toBe("50");
      expect(init.method).toBe("GET");
    });

    it("gets a protected wildcard branch with an encoded path", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ name: "release/*" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getProtectedBranch("group/project", "release/*");

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(String(requestUrl)).toContain(
        "/projects/group%2Fproject/protected_branches/release%2F*"
      );
      expect(init.method).toBe("GET");
    });

    it("protects a branch with explicit access settings", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ name: "release/*" }, 201));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.protectBranch("group/project", {
        name: "release/*",
        push_access_level: 0,
        merge_access_level: 30,
        unprotect_access_level: 40,
        allow_force_push: false,
        code_owner_approval_required: true
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(String(requestUrl)).toContain("/projects/group%2Fproject/protected_branches");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({
        name: "release/*",
        push_access_level: 0,
        merge_access_level: 30,
        unprotect_access_level: 40,
        allow_force_push: false,
        code_owner_approval_required: true
      });
    });

    it("unprotects an encoded wildcard branch", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.unprotectBranch("group/project", "release/*");

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(String(requestUrl)).toContain(
        "/projects/group%2Fproject/protected_branches/release%2F*"
      );
      expect(init.method).toBe("DELETE");
    });

    it("updates the default branch with a JSON payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ default_branch: "stable" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.updateDefaultBranch("group/project", "stable");

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(String(requestUrl)).toContain("/projects/group%2Fproject");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body as string)).toEqual({ default_branch: "stable" });
    });

    it("preserves legacy repository tree array responses", async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ name: "src", type: "tree" }]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.getRepositoryTree("proj", {
        query: { path: "src", ref: "main", recursive: true }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/repository/tree");
      expect(url.searchParams.get("path")).toBe("src");
      expect(url.searchParams.get("ref")).toBe("main");
      expect(url.searchParams.get("recursive")).toBe("true");
      expect(result).toEqual([{ name: "src", type: "tree" }]);
    });

    it("returns keyset repository tree pagination token", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([{ name: "a.ts", type: "blob" }], 200, {
          "x-next-page-token": "abc123"
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.getRepositoryTree("proj", {
        query: { pagination: "keyset", per_page: 1 }
      });

      expect(result).toEqual({
        items: [{ name: "a.ts", type: "blob" }],
        next_page_token: "abc123",
        pagination_note:
          "Pass next_page_token as page_token with pagination=keyset to retrieve the next page."
      });
      expect(getPaginationMetadata(result)).toEqual({ next_page_token: "abc123" });
    });

    it("uses x-next-page as keyset repository tree token fallback", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([{ name: "b.ts", type: "blob" }], 200, {
          "x-next-page": "fallback-token"
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.getRepositoryTree("proj", {
        query: { pagination: "keyset" }
      });

      expect(result).toMatchObject({
        items: [{ name: "b.ts", type: "blob" }],
        next_page_token: "fallback-token"
      });
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

    it("gets file blame with encoded path and range", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getFileBlame("proj", "src/index.ts", "main", {
        query: {
          "range[start]": 10,
          "range[end]": 20
        }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/repository/files/src%2Findex.ts/blame");
      expect(url.searchParams.get("ref")).toBe("main");
      expect(url.searchParams.get("range[start]")).toBe("10");
      expect(url.searchParams.get("range[end]")).toBe("20");
    });

    it("requests merge request diverged commit count by default", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ iid: 7, diverged_commits_count: 3 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getMergeRequest("proj", "7");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/merge_requests/7");
      expect(url.searchParams.get("include_diverged_commits_count")).toBe("true");
    });

    it("counts merge request commits across pages", async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse([{ id: "a" }, { id: "b" }], 200, {
            "x-next-page": "2"
          })
        )
        .mockResolvedValueOnce(jsonResponse([{ id: "c" }]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const count = await client.countMergeRequestCommits("proj", "7");

      expect(count).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [firstUrl] = fetchMock.mock.calls[0] as [URL | string];
      const [secondUrl] = fetchMock.mock.calls[1] as [URL | string];
      expect(new URL(String(firstUrl)).searchParams.get("page")).toBe("1");
      expect(new URL(String(secondUrl)).searchParams.get("page")).toBe("2");
    });

    it("adds approvers to merge request approval_state responses", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          rules: [
            {
              approved: true,
              approved_by: [
                { id: 1, username: "alice" },
                { id: 1, username: "alice" }
              ]
            }
          ]
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.getMergeRequestApprovalState("proj", "7");

      expect(result).toMatchObject({
        approved_by: [{ id: 1, username: "alice" }],
        approved_by_usernames: ["alice"],
        source_endpoint: "approval_state"
      });
    });

    it("falls back to approvals endpoint when approval_state is unavailable", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: "404" }, 404)).mockResolvedValueOnce(
        jsonResponse({
          approved: true,
          user_has_approved: false,
          user_can_approve: true,
          approved_by: [{ user: { id: 2, username: "bob" } }]
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.getMergeRequestApprovalState("proj", "7");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        approved: true,
        user_has_approved: false,
        user_can_approve: true,
        approved_by_usernames: ["bob"],
        source_endpoint: "approvals"
      });
    });

    it("uploads markdown file", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ markdown: "![file](/uploads/abc/file.md)" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.uploadMarkdown("proj", "# Hello", "readme.md");

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
    });

    it("reads local upload files only from configured roots", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ markdown: "[file](/uploads/abc/file.md)" }));
      const allowedRoot = await createTempDir("gitlab-upload-allowed-");
      const outsideRoot = await createTempDir("gitlab-upload-outside-");
      const allowedFile = path.join(allowedRoot, "allowed.md");
      const outsideFile = path.join(outsideRoot, "outside.md");
      await fs.writeFile(allowedFile, "allowed", "utf8");
      await fs.writeFile(outsideFile, "outside", "utf8");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        localFileRoots: [allowedRoot]
      });

      await expect(client.uploadMarkdownFile("proj", allowedFile)).resolves.toBeDefined();
      await expect(client.uploadMarkdownFile("proj", outsideFile)).rejects.toThrow(
        /outside GITLAB_LOCAL_FILE_ROOTS/u
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("uses the current working directory as the default local file root", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ markdown: "[file](/uploads/abc/file.md)" }));
      const client = new GitLabClient("https://gitlab.example.com", "token");

      await client.uploadMarkdownFile("proj", path.join(process.cwd(), "package.json"));

      expect(fetchMock).toHaveBeenCalledTimes(1);
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

    it("creates pipeline with typed spec inputs", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 2 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createPipeline("proj", {
        ref: "release",
        inputs: {
          environment: "production",
          approvals_required: 2,
          dry_run: false,
          regions: ["cn", "us-east"]
        }
      });

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.ref).toBe("release");
      expect(body.inputs).toEqual({
        environment: "production",
        approvals_required: 2,
        dry_run: false,
        regions: ["cn", "us-east"]
      });
    });

    it("validates CI lint content with JSON payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ valid: true, errors: [] }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.validateCiLint("proj", {
        content: "test:\n  script: echo ok",
        dry_run: true,
        include_jobs: true,
        ref: "main"
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body as string);

      expect(String(requestUrl)).toContain("/projects/proj/ci/lint");
      expect(init.method).toBe("POST");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(body).toEqual({
        content: "test:\n  script: echo ok",
        dry_run: true,
        include_jobs: true,
        ref: "main"
      });
    });

    it("validates project CI lint with query parameters", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ valid: true, errors: [] }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.validateProjectCiLint("proj", {
        query: {
          content_ref: "feature/test",
          dry_run: true,
          dry_run_ref: "main",
          include_jobs: true
        }
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const url = new URL(String(requestUrl));

      expect(url.pathname).toContain("/projects/proj/ci/lint");
      expect(init.method).toBe("GET");
      expect(url.searchParams.get("content_ref")).toBe("feature/test");
      expect(url.searchParams.get("dry_run")).toBe("true");
      expect(url.searchParams.get("dry_run_ref")).toBe("main");
      expect(url.searchParams.get("include_jobs")).toBe("true");
    });

    it("gets merge request conflicts", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ conflict_files: [] }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getMergeRequestConflicts("proj", "123");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/projects/proj/merge_requests/123/conflicts");
    });

    it("lists merge request pipelines with pagination", async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ id: 77, status: "success" }]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listMergeRequestPipelines("proj", "123", {
        query: { page: 2, per_page: 10 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));

      expect(url.pathname).toContain("/projects/proj/merge_requests/123/pipelines");
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("per_page")).toBe("10");
    });

    it("lists deployments with query parameters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listDeployments("proj", {
        query: {
          environment: "production",
          updated_after: "2026-02-01T00:00:00Z",
          page: 2
        }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/deployments");
      expect(url.searchParams.get("environment")).toBe("production");
      expect(url.searchParams.get("updated_after")).toBe("2026-02-01T00:00:00Z");
      expect(url.searchParams.get("page")).toBe("2");
    });

    it("lists environments with search parameters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listEnvironments("proj", {
        query: {
          search: "prod",
          states: "available"
        }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/environments");
      expect(url.searchParams.get("search")).toBe("prod");
      expect(url.searchParams.get("states")).toBe("available");
    });

    it("lists job artifacts with path and recursive filters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listJobArtifacts("proj", "123", {
        query: {
          path: "coverage",
          recursive: true
        }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/jobs/123/artifacts/tree");
      expect(url.searchParams.get("path")).toBe("coverage");
      expect(url.searchParams.get("recursive")).toBe("true");
    });

    it("downloads job artifacts as base64 content", async () => {
      fetchMock.mockResolvedValue(
        new Response("PK\x03\x04", {
          status: 200,
          headers: {
            "content-type": "application/zip"
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.downloadJobArtifacts("proj", "456");

      expect(result.fileName).toBe("artifacts-job-456.zip");
      expect(result.contentType).toBe("application/zip");
      expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from("PK\x03\x04"));
    });

    it("downloads streamed job artifacts with the attachment size limit", async () => {
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
            "content-type": "application/zip"
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxAttachmentBytes: 8,
        maxLocalFileBytes: 10
      });
      const error = await client.downloadJobArtifacts("proj", "458").catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exceeds limit");
    });

    it("downloads job artifacts to a local directory", async () => {
      fetchMock.mockResolvedValue(
        new Response("PK\x03\x04", {
          status: 200,
          headers: {
            "content-type": "application/zip"
          }
        })
      );

      const outputDir = await createTempDir("gitlab-job-artifacts-");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        localFileRoots: [outputDir]
      });
      const result = await client.saveJobArtifacts("proj", "456", outputDir);

      expect(result.fileName).toBe("artifacts-job-456.zip");
      expect(result.contentType).toBe("application/zip");
      expect(result.filePath).toBe(
        path.join(await fs.realpath(outputDir), "artifacts-job-456.zip")
      );
      expect(result.size).toBe(4);
      await expect(fs.readFile(result.filePath, "binary")).resolves.toBe("PK\x03\x04");
    });

    it("uses the local file limit for streamed artifact downloads", async () => {
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
            "content-type": "application/zip"
          }
        })
      );

      const outputDir = await createTempDir("gitlab-job-artifacts-streamed-");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxAttachmentBytes: 8,
        maxLocalFileBytes: 10,
        localFileRoots: [outputDir]
      });
      const result = await client.saveJobArtifacts("proj", "458", outputDir);

      expect(result.filePath).toBe(
        path.join(await fs.realpath(outputDir), "artifacts-job-458.zip")
      );
      expect(result.size).toBe(10);
      await expect(fs.readFile(result.filePath, "utf8")).resolves.toBe("1234567890");
    });

    it("sanitizes downloaded artifact filenames before saving locally", async () => {
      fetchMock.mockResolvedValue(
        new Response("safe\n", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-disposition": 'attachment; filename="../../outside.txt"'
          }
        })
      );

      const outputDir = await createTempDir("gitlab-artifact-safe-name-");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        localFileRoots: [outputDir]
      });
      const result = await client.saveJobArtifacts("proj", "457", outputDir);

      expect(result.fileName).toBe("outside.txt");
      expect(result.filePath).toBe(path.join(await fs.realpath(outputDir), "outside.txt"));
      await expect(fs.readFile(result.filePath, "utf8")).resolves.toBe("safe\n");
    });

    it("does not overwrite an existing local artifact file", async () => {
      fetchMock.mockResolvedValue(
        new Response("new artifact\n", {
          status: 200,
          headers: {
            "content-type": "text/plain"
          }
        })
      );

      const outputDir = await createTempDir("gitlab-artifact-existing-file-");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        localFileRoots: [outputDir]
      });
      const existingFilePath = path.join(outputDir, "artifacts-job-457.zip");
      await fs.writeFile(existingFilePath, "existing artifact\n", "utf8");

      const result = await client.saveJobArtifacts("proj", "457", outputDir);

      expect(result.fileName).toBe("artifacts-job-457-1.zip");
      expect(result.filePath).toBe(
        path.join(await fs.realpath(outputDir), "artifacts-job-457-1.zip")
      );
      await expect(fs.readFile(existingFilePath, "utf8")).resolves.toBe("existing artifact\n");
      await expect(fs.readFile(result.filePath, "utf8")).resolves.toBe("new artifact\n");
      await expect(fs.readdir(outputDir)).resolves.toEqual([
        "artifacts-job-457-1.zip",
        "artifacts-job-457.zip"
      ]);
    });

    it("cleans up partial files when local artifact download exceeds configured limit", async () => {
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
            "content-type": "application/zip"
          }
        })
      );

      const outputDir = await createTempDir("gitlab-job-artifacts-limit-");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxLocalFileBytes: 9,
        localFileRoots: [outputDir]
      });
      const filePath = path.join(outputDir, "artifacts-job-459.zip");
      const error = await client
        .saveJobArtifacts("proj", "459", outputDir)
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exceeds limit");
      await expect(fs.access(filePath)).rejects.toBeDefined();
    });

    it("preserves an existing file when a local artifact download fails", async () => {
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
            "content-type": "application/zip"
          }
        })
      );

      const outputDir = await createTempDir("gitlab-job-artifacts-existing-limit-");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxLocalFileBytes: 9,
        localFileRoots: [outputDir]
      });
      const existingFilePath = path.join(outputDir, "artifacts-job-460.zip");
      await fs.writeFile(existingFilePath, "keep me\n", "utf8");

      const error = await client
        .saveJobArtifacts("proj", "460", outputDir)
        .catch((reason) => reason);

      expect(error).toBeInstanceOf(Error);
      await expect(fs.readFile(existingFilePath, "utf8")).resolves.toBe("keep me\n");
      await expect(fs.readdir(outputDir)).resolves.toEqual(["artifacts-job-460.zip"]);
    });

    it("returns UTF-8 content for text artifact files", async () => {
      fetchMock.mockResolvedValue(
        new Response("coverage: 99%\n", {
          status: 200,
          headers: {
            "content-type": "text/plain"
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.getJobArtifactFile("proj", "789", "reports/summary.txt");

      expect(result).toEqual({
        fileName: "summary.txt",
        contentType: "text/plain",
        encoding: "utf8",
        content: "coverage: 99%\n"
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/projects/proj/jobs/789/artifacts/reports/summary.txt");
    });

    it("returns base64 content for binary artifact files", async () => {
      fetchMock.mockResolvedValue(
        new Response(new Uint8Array([0, 1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="report.bin"'
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.getJobArtifactFile("proj", "790", "reports/report.bin");

      expect(result.fileName).toBe("report.bin");
      expect(result.contentType).toBe("application/octet-stream");
      expect(result.encoding).toBe("base64");
      expect(Buffer.from(result.content, "base64")).toEqual(Buffer.from([0, 1, 2, 3]));
    });

    it("saves artifact files to a local directory", async () => {
      fetchMock.mockResolvedValue(
        new Response("coverage: 99%\n", {
          status: 200,
          headers: {
            "content-type": "text/plain"
          }
        })
      );

      const outputDir = await createTempDir("gitlab-artifact-file-");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        localFileRoots: [outputDir]
      });
      const result = await client.saveJobArtifactFile(
        "proj",
        "791",
        "reports/summary.txt",
        outputDir
      );

      expect(result.fileName).toBe("summary.txt");
      expect(result.filePath).toBe(path.join(await fs.realpath(outputDir), "summary.txt"));
      expect(result.size).toBe(Buffer.byteLength("coverage: 99%\n"));
      await expect(fs.readFile(result.filePath, "utf8")).resolves.toBe("coverage: 99%\n");
    });

    it("rejects artifact output directories that escape through a symbolic link", async () => {
      const allowedRoot = await createTempDir("gitlab-download-allowed-");
      const outsideRoot = await createTempDir("gitlab-download-outside-");
      await fs.symlink(outsideRoot, path.join(allowedRoot, "escape"), "dir");
      const client = new GitLabClient("https://gitlab.example.com", "token", {
        localFileRoots: [allowedRoot]
      });

      await expect(
        client.saveJobArtifacts("proj", "792", path.join(allowedRoot, "escape"))
      ).rejects.toThrow(/outside GITLAB_LOCAL_FILE_ROOTS/u);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gets commit diff", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getCommitDiff("proj", "abc123");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/commits/abc123/diff");
    });

    it("lists commit statuses with filters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listCommitStatuses("proj", "abc123", {
        query: { ref: "main", name: "external/check", all: false, per_page: 20 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/repository/commits/abc123/statuses");
      expect(url.searchParams.get("ref")).toBe("main");
      expect(url.searchParams.get("name")).toBe("external/check");
      expect(url.searchParams.get("all")).toBe("false");
      expect(url.searchParams.get("per_page")).toBe("20");
    });

    it("creates commit status with query payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "success" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createCommitStatus("proj", "abc123", {
        state: "success",
        ref: "main",
        context: "external/check",
        target_url: "https://ci.example.com/build/1",
        coverage: 87.5,
        pipeline_id: 42
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/statuses/abc123");
      expect(init.method).toBe("POST");
      expect(url.searchParams.get("state")).toBe("success");
      expect(url.searchParams.get("context")).toBe("external/check");
      expect(url.searchParams.get("coverage")).toBe("87.5");
      expect(url.searchParams.get("pipeline_id")).toBe("42");
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

    it("manages merge request emoji reactions", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([{ id: 1, name: "rocket" }]))
        .mockResolvedValueOnce(jsonResponse({ id: 2, name: "thumbsup" }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listMergeRequestEmojiReactions("group/project", "7", {
        query: { page: 2 }
      });
      await client.createMergeRequestNoteEmojiReaction("group/project", "7", "33", {
        discussion_id: "disc-1",
        name: "thumbsup"
      });
      await client.deleteMergeRequestEmojiReaction("group/project", "7", "2");

      const [listUrl, listInit] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const [createUrl, createInit] = fetchMock.mock.calls[1] as [URL | string, RequestInit];
      const [deleteUrl, deleteInit] = fetchMock.mock.calls[2] as [URL | string, RequestInit];

      expect(String(listUrl)).toContain("/projects/group%2Fproject/merge_requests/7/award_emoji");
      expect(new URL(String(listUrl)).searchParams.get("page")).toBe("2");
      expect(listInit.method).toBe("GET");
      expect(String(createUrl)).toContain(
        "/merge_requests/7/discussions/disc-1/notes/33/award_emoji"
      );
      expect(createInit.method).toBe("POST");
      expect(JSON.parse(createInit.body as string)).toEqual({ name: "thumbsup" });
      expect(String(deleteUrl)).toContain("/merge_requests/7/award_emoji/2");
      expect(deleteInit.method).toBe("DELETE");
    });

    it("manages issue emoji reactions", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: 2, name: "rocket" }))
        .mockResolvedValueOnce(jsonResponse([{ id: 3, name: "eyes" }]))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createIssueEmojiReaction("group/project", "5", "rocket");
      await client.listIssueNoteEmojiReactions("group/project", "5", "44", {
        discussion_id: "disc-1"
      });
      await client.deleteIssueNoteEmojiReaction("group/project", "5", "44", {
        discussion_id: "disc-1",
        award_id: "3"
      });

      const [createUrl, createInit] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const [listUrl, listInit] = fetchMock.mock.calls[1] as [URL | string, RequestInit];
      const [deleteUrl, deleteInit] = fetchMock.mock.calls[2] as [URL | string, RequestInit];

      expect(String(createUrl)).toContain("/projects/group%2Fproject/issues/5/award_emoji");
      expect(createInit.method).toBe("POST");
      expect(JSON.parse(createInit.body as string)).toEqual({ name: "rocket" });
      expect(String(listUrl)).toContain("/issues/5/discussions/disc-1/notes/44/award_emoji");
      expect(listInit.method).toBe("GET");
      expect(String(deleteUrl)).toContain("/issues/5/discussions/disc-1/notes/44/award_emoji/3");
      expect(deleteInit.method).toBe("DELETE");
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

    it("lists todos with filters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ id: 102, state: "pending" }]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listTodos({
        query: { state: "pending", action: "assigned", project_id: 123, page: 2 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toBe("/api/v4/todos");
      expect(url.searchParams.get("state")).toBe("pending");
      expect(url.searchParams.get("action")).toBe("assigned");
      expect(url.searchParams.get("project_id")).toBe("123");
      expect(url.searchParams.get("page")).toBe("2");
    });

    it("marks todos done", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 102, state: "done" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.markTodoDone("102");
      await client.markAllTodosDone();

      const [oneUrl, oneInit] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const [allUrl, allInit] = fetchMock.mock.calls[1] as [URL | string, RequestInit];

      expect(new URL(String(oneUrl)).pathname).toBe("/api/v4/todos/102/mark_as_done");
      expect(oneInit.method).toBe("POST");
      expect(new URL(String(allUrl)).pathname).toBe("/api/v4/todos/mark_as_done");
      expect(allInit.method).toBe("POST");
    });

    it("passes wiki render options through and preserves front matter", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          slug: "home",
          content: "<p>Hello</p>",
          front_matter: { title: "Custom home" }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const page = await client.getWikiPage("group/project", "home", {
        query: { render_html: true }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(new URL(String(requestUrl)).searchParams.get("render_html")).toBe("true");
      expect(page).toMatchObject({ front_matter: { title: "Custom home" } });
    });

    it("uses group wiki endpoints", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ slug: "home" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listGroupWikiPages("parent/group", {
        query: { with_content: true, render_html: true }
      });
      await client.getGroupWikiPage("parent/group", "home", {
        query: { render_html: true }
      });
      await client.createGroupWikiPage("parent/group", { title: "Home", content: "Hello" });
      await client.updateGroupWikiPage("parent/group", "home", { content: "Updated" });
      await client.deleteGroupWikiPage("parent/group", "home");

      const [listUrl] = fetchMock.mock.calls[0] as [URL | string];
      const [getUrl] = fetchMock.mock.calls[1] as [URL | string];
      const [, createInit] = fetchMock.mock.calls[2] as [URL | string, RequestInit];
      const [, updateInit] = fetchMock.mock.calls[3] as [URL | string, RequestInit];
      const [, deleteInit] = fetchMock.mock.calls[4] as [URL | string, RequestInit];

      expect(new URL(String(listUrl)).pathname).toBe("/api/v4/groups/parent%2Fgroup/wikis");
      expect(new URL(String(listUrl)).searchParams.get("with_content")).toBe("true");
      expect(new URL(String(listUrl)).searchParams.get("render_html")).toBe("true");
      expect(new URL(String(getUrl)).pathname).toBe("/api/v4/groups/parent%2Fgroup/wikis/home");
      expect(new URL(String(getUrl)).searchParams.get("render_html")).toBe("true");
      expect(createInit.method).toBe("POST");
      expect(updateInit.method).toBe("PUT");
      expect(deleteInit.method).toBe("DELETE");
    });

    it("lists project and group webhooks", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listWebhooks({ projectId: "group/project" }, { query: { page: 2 } });
      await client.listWebhooks({ groupId: "parent/group" }, { query: { per_page: 10 } });

      const [projectUrl] = fetchMock.mock.calls[0] as [URL | string];
      const [groupUrl] = fetchMock.mock.calls[1] as [URL | string];
      const project = new URL(String(projectUrl));
      const group = new URL(String(groupUrl));

      expect(project.pathname).toBe("/api/v4/projects/group%2Fproject/hooks");
      expect(project.searchParams.get("page")).toBe("2");
      expect(group.pathname).toBe("/api/v4/groups/parent%2Fgroup/hooks");
      expect(group.searchParams.get("per_page")).toBe("10");
    });

    it("lists webhook events", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listWebhookEvents({ projectId: "group/project" }, "7", {
        query: { status: "successful", page: 3, per_page: 20 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toBe("/api/v4/projects/group%2Fproject/hooks/7/events");
      expect(url.searchParams.get("status")).toBe("successful");
      expect(url.searchParams.get("page")).toBe("3");
      expect(url.searchParams.get("per_page")).toBe("20");
    });

    it("gets one user by ID", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 42, username: "alice" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getUser("42");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/api/v4/users/42");
    });

    it("gets the current authenticated user", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ id: 42, username: "alice" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.whoami();

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(new URL(String(requestUrl)).pathname).toBe("/api/v4/user");
    });

    it("releases use encoded tag names", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getRelease("proj", "v1.0.0");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      expect(String(requestUrl)).toContain("/releases/v1.0.0");
    });

    it("downloadReleaseAsset encodes path segments and returns binary content as base64", async () => {
      const bytes = new Uint8Array([0, 255, 1, 2]);
      fetchMock.mockResolvedValue(
        new Response(bytes, {
          headers: {
            "content-type": "application/gzip",
            "content-disposition": 'attachment; filename="asset.tar.gz"'
          }
        })
      );

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const result = await client.downloadReleaseAsset("proj", "v1.0", "bin/my app.tar.gz");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const urlStr = String(requestUrl);
      expect(urlStr).toContain("/downloads/bin/my%20app.tar.gz");
      expect(result).toEqual({
        fileName: "asset.tar.gz",
        contentType: "application/gzip",
        base64: Buffer.from(bytes).toString("base64")
      });
    });

    it("lists tags with filters", async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ name: "v1.0.0" }]));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.listTags("proj", {
        query: { search: "^v", order_by: "version", sort: "desc", per_page: 10 }
      });

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.pathname).toContain("/projects/proj/repository/tags");
      expect(url.searchParams.get("search")).toBe("^v");
      expect(url.searchParams.get("order_by")).toBe("version");
      expect(url.searchParams.get("sort")).toBe("desc");
      expect(url.searchParams.get("per_page")).toBe("10");
    });

    it("gets, deletes, and reads signatures for encoded tag names", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ name: "release/v1" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.getTag("proj", "release/v1");
      await client.deleteTag("proj", "release/v1");
      await client.getTagSignature("proj", "release/v1");

      const [getUrl] = fetchMock.mock.calls[0] as [URL | string];
      const [, deleteInit] = fetchMock.mock.calls[1] as [URL | string, RequestInit];
      const [signatureUrl] = fetchMock.mock.calls[2] as [URL | string];

      expect(String(getUrl)).toContain("/repository/tags/release%2Fv1");
      expect(deleteInit.method).toBe("DELETE");
      expect(String(signatureUrl)).toContain("/repository/tags/release%2Fv1/signature");
    });

    it("creates tags with JSON payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ name: "v1.0.0" }));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.createTag("proj", {
        tag_name: "v1.0.0",
        ref: "main",
        message: "Release tag"
      });

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      const headers = new Headers(init.headers);
      const body = JSON.parse(init.body as string);

      expect(String(requestUrl)).toContain("/projects/proj/repository/tags");
      expect(init.method).toBe("POST");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(body).toEqual({
        tag_name: "v1.0.0",
        ref: "main",
        message: "Release tag"
      });
    });

    it("deleteLabel uses query param for label name", async () => {
      fetchMock.mockResolvedValue(jsonResponse(null));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      await client.deleteLabel("proj", "bug");

      const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
      const url = new URL(String(requestUrl));
      expect(url.searchParams.get("name")).toBe("bug");
    });

    it("uses encoded project/group CI variable endpoints and filter queries", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ key: "TOKEN" }));
      const client = new GitLabClient("https://gitlab.example.com", "token");

      await client.listProjectVariables("group/project", {
        query: { page: 2, per_page: 50 }
      });
      await client.getGroupVariable("group/subgroup", "TOKEN", {
        query: { "filter[environment_scope]": "production" }
      });

      const projectListUrl = new URL(String((fetchMock.mock.calls[0] as [URL])[0]));
      expect(projectListUrl.pathname).toContain("/projects/group%2Fproject/variables");
      expect(projectListUrl.searchParams.get("page")).toBe("2");
      expect(projectListUrl.searchParams.get("per_page")).toBe("50");

      const groupGetUrl = new URL(String((fetchMock.mock.calls[1] as [URL])[0]));
      expect(groupGetUrl.pathname).toContain("/groups/group%2Fsubgroup/variables/TOKEN");
      expect(groupGetUrl.searchParams.get("filter[environment_scope]")).toBe("production");
    });

    it("sends CI variable writes as JSON and supports filtered deletion", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ key: "TOKEN" }));
      const client = new GitLabClient("https://gitlab.example.com", "token");

      await client.createProjectVariable("group/project", {
        key: "TOKEN",
        value: "secret"
      });
      await client.updateGroupVariable(
        "group/subgroup",
        "TOKEN",
        { value: "replacement" },
        { query: { "filter[environment_scope]": "production" } }
      );
      await client.deleteProjectVariable("group/project", "TOKEN", {
        query: { "filter[environment_scope]": "staging" }
      });

      const [createUrl, createInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(String(createUrl)).toContain("/projects/group%2Fproject/variables");
      expect(createInit.method).toBe("POST");
      expect(new Headers(createInit.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(createInit.body as string)).toEqual({ key: "TOKEN", value: "secret" });

      const [updateUrl, updateInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
      expect(String(updateUrl)).toContain("/groups/group%2Fsubgroup/variables/TOKEN");
      expect(new URL(String(updateUrl)).searchParams.get("filter[environment_scope]")).toBe(
        "production"
      );
      expect(updateInit.method).toBe("PUT");
      expect(JSON.parse(updateInit.body as string)).toEqual({ value: "replacement" });

      const [deleteUrl, deleteInit] = fetchMock.mock.calls[2] as [URL, RequestInit];
      expect(String(deleteUrl)).toContain("/projects/group%2Fproject/variables/TOKEN");
      expect(new URL(String(deleteUrl)).searchParams.get("filter[environment_scope]")).toBe(
        "staging"
      );
      expect(deleteInit.method).toBe("DELETE");
    });

    it("gets groups and purges the encoded Dependency Proxy cache endpoint", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ full_path: "group/subgroup" }));
      const client = new GitLabClient("https://gitlab.example.com", "token");

      await client.getGroup("group/subgroup");
      await client.purgeDependencyProxyCache("group/subgroup");

      const [getUrl, getInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(String(getUrl)).toContain("/groups/group%2Fsubgroup");
      expect(getInit.method).toBe("GET");

      const [purgeUrl, purgeInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
      expect(String(purgeUrl)).toContain("/groups/group%2Fsubgroup/dependency_proxy/cache");
      expect(purgeInit.method).toBe("DELETE");
    });

    it("bounds job traces by line count and marks them as untrusted", async () => {
      const trace = Array.from({ length: 1_100 }, (_, index) => `line-${index}`).join("\n");
      fetchMock.mockResolvedValue(textResponse(trace));

      const client = new GitLabClient("https://gitlab.example.com", "token");
      const output = await client.getPipelineJobOutput("group/project", "77", {
        limit: 5_000,
        offset: 2
      });
      const [, selectedTrace = ""] = output.split("\n\n", 2);

      expect(output).toContain("[Untrusted CI job trace:");
      expect(output).toContain("[Log line-limited:");
      expect(selectedTrace.split("\n")).toHaveLength(1_000);
      expect(selectedTrace).toContain("line-1097");
      expect(selectedTrace).not.toContain("line-1098");

      const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(String(requestUrl)).toContain("/projects/group%2Fproject/jobs/77/trace");
      expect(new Headers(init.headers).get("Range")).toBe("bytes=-1048576");
      expect(new Headers(init.headers).get("Accept")).toBe("text/plain");
    });

    it("stops reading job traces at the configured byte cap", async () => {
      fetchMock.mockResolvedValue(textResponse("0123456789\nsecond-line\nthird-line"));

      const client = new GitLabClient("https://gitlab.example.com", "token", {
        maxJobTraceBytes: 16
      });
      const output = await client.getPipelineJobOutput("proj", "8");

      expect(output).toContain("[Log byte-limited to 16 bytes;");
      expect(output).toContain("0123456789\nsecon");
      expect(output).not.toContain("third-line");

      const [, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
      expect(new Headers(init.headers).get("Range")).toBe("bytes=-16");
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
