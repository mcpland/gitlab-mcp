import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { GitLabApiError, GitLabClient } from "../src/lib/gitlab-client.js";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("GitLabClient", () => {
  it("sends private token header when token is provided", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 1,
          name: "demo",
          description: null,
          path_with_namespace: "group/demo",
          default_branch: "main",
          web_url: "https://gitlab.example.com/group/demo",
          visibility: "private",
          last_activity_at: "2026-01-01T00:00:00Z"
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const client = new GitLabClient("https://gitlab.example.com", "token-123");

    await client.getProject("group/demo");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];

    expect(String(requestUrl)).toContain("/api/v4/projects/group%2Fdemo");
    expect(new Headers(init.headers).get("PRIVATE-TOKEN")).toBe("token-123");
  });

  it("throws GitLabApiError for non-2xx responses", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "404 Project Not Found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" }
      })
    );

    const client = new GitLabClient("https://gitlab.example.com", "token-123");

    const error = await client.getProject("missing/project").catch((reason) => reason);

    expect(error).toBeInstanceOf(GitLabApiError);
    expect(error).toMatchObject({ status: 404 });
  });

  it("adds query params for project search", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const client = new GitLabClient("https://gitlab.example.com");

    await client.searchProjects("backend", 7);

    const [requestUrl] = fetchMock.mock.calls[0] as [URL | string];
    const url = new URL(String(requestUrl));

    expect(url.pathname).toBe("/api/v4/projects");
    expect(url.searchParams.get("search")).toBe("backend");
    expect(url.searchParams.get("simple")).toBe("true");
    expect(url.searchParams.get("per_page")).toBe("7");
  });

  it("supports global merge request listing endpoint", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

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
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

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
});
