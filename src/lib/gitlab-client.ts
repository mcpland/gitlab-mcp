export interface GitLabNamespace {
  id: number;
  name: string;
  full_path: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  description: string | null;
  path_with_namespace: string;
  default_branch: string | null;
  web_url: string;
  visibility: string;
  last_activity_at: string;
  namespace?: GitLabNamespace;
}

export class GitLabApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "GitLabApiError";
  }
}

interface GitLabClientOptions {
  timeoutMs?: number;
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token?: string, options: GitLabClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async getProject(projectIdOrPath: string): Promise<GitLabProject> {
    const encoded = encodeURIComponent(projectIdOrPath);

    return this.request<GitLabProject>(`/api/v4/projects/${encoded}`);
  }

  async searchProjects(query: string, limit = 10): Promise<GitLabProject[]> {
    return this.request<GitLabProject[]>("/api/v4/projects", {
      query: {
        search: query,
        simple: true,
        per_page: limit
      }
    });
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: BodyInit;
      query?: Record<string, string | number | boolean | undefined>;
      headers?: HeadersInit;
    } = {}
  ): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), `${this.baseUrl}/`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");

    if (this.token) {
      headers.set("PRIVATE-TOKEN", this.token);
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      body: options.body,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    const payload = await this.parseBody(response);

    if (!response.ok) {
      throw new GitLabApiError(
        `GitLab API request failed: ${response.status} ${response.statusText}`,
        response.status,
        payload
      );
    }

    return payload as T;
  }

  private async parseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      return response.json();
    }

    return response.text();
  }
}
