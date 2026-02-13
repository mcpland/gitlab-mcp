import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getSessionAuth, type SessionAuth } from "./auth-context.js";

export interface GitLabClientOptions {
  timeoutMs?: number;
  apiUrls?: string[];
  beforeRequest?: (
    context: GitLabBeforeRequestContext
  ) => Promise<GitLabBeforeRequestResult | void>;
}

export interface GitLabRequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: BodyInit;
  headers?: HeadersInit;
  token?: string;
  apiUrl?: string;
}

export interface GitLabBeforeRequestContext {
  url: URL;
  method: string;
  headers: Headers;
  body?: BodyInit;
  token?: string;
}

export interface GitLabBeforeRequestResult {
  headers?: Headers;
  body?: BodyInit;
  token?: string;
  fetchImpl?: typeof fetch;
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
}

export interface PushFileAction {
  action: "create" | "delete" | "move" | "update" | "chmod";
  file_path: string;
  previous_path?: string;
  content?: string;
  encoding?: "text" | "base64";
  execute_filemode?: boolean;
  last_commit_id?: string;
}

export interface MergeRequestCodeContextFile {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
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

export class GitLabClient {
  private readonly baseApiUrl: string;
  private readonly apiUrls: string[];
  private nextApiUrlIndex = 0;
  private readonly defaultToken?: string;
  private readonly timeoutMs: number;
  private readonly beforeRequest?: GitLabClientOptions["beforeRequest"];

  constructor(baseApiUrl: string, defaultToken?: string, options: GitLabClientOptions = {}) {
    this.baseApiUrl = normalizeApiUrl(baseApiUrl);
    const configuredApiUrls = options.apiUrls
      ?.map((item) => normalizeApiUrl(item))
      .filter((item) => item.length > 0) ?? [this.baseApiUrl];
    this.apiUrls = configuredApiUrls.length > 0 ? configuredApiUrls : [this.baseApiUrl];
    this.defaultToken = defaultToken;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.beforeRequest = options.beforeRequest;
  }

  // projects
  getProject(projectId: string, options?: GitLabRequestOptions): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}`, options);
  }

  listProjects(options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get("/projects", options);
  }

  createRepository(
    payload: {
      name: string;
      description?: string;
      visibility?: "private" | "internal" | "public";
      initialize_with_readme?: boolean;
      path?: string;
      namespace_id?: string | number;
      default_branch?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post("/projects", {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  listProjectMembers(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/members/all`, options);
  }

  listGroupProjects(groupId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/groups/${encode(groupId)}/projects`, options);
  }

  forkRepository(
    projectId: string,
    payload: {
      namespace?: string;
      namespace_id?: string | number;
      path?: string;
      name?: string;
      description?: string;
      visibility?: "private" | "internal" | "public";
      default_branch?: string;
    } = {},
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/fork`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  searchProjects(search: string, limit = 10, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get("/projects", {
      ...options,
      query: {
        search,
        simple: true,
        per_page: limit,
        ...(options.query ?? {})
      }
    });
  }

  searchRepositories(search: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get("/search", {
      ...options,
      query: {
        scope: "projects",
        search,
        ...(options.query ?? {})
      }
    });
  }

  searchCodeBlobs(
    projectId: string,
    search: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/search`, {
      ...options,
      query: {
        scope: "blobs",
        search,
        ...(options.query ?? {})
      }
    });
  }

  // repository/files
  getRepositoryTree(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/repository/tree`, options);
  }

  getFileContents(
    projectId: string,
    filePath: string,
    ref: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/repository/files/${encode(filePath)}`, {
      ...options,
      query: {
        ref,
        ...(options.query ?? {})
      }
    });
  }

  createOrUpdateFile(
    projectId: string,
    filePath: string,
    payload: {
      branch: string;
      content: string;
      commit_message: string;
      author_email?: string;
      author_name?: string;
      encoding?: "text" | "base64";
      execute_filemode?: boolean;
      start_branch?: string;
      last_commit_id?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(`/projects/${encode(projectId)}/repository/files/${encode(filePath)}`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  pushFiles(
    projectId: string,
    payload: {
      branch: string;
      commit_message: string;
      actions: PushFileAction[];
      start_branch?: string;
      author_name?: string;
      author_email?: string;
      force?: boolean;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/repository/commits`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  createBranch(
    projectId: string,
    payload: {
      branch: string;
      ref: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/repository/branches`, {
      ...options,
      query: payload
    });
  }

  getBranchDiffs(
    projectId: string,
    payload: {
      from: string;
      to: string;
      straight?: boolean;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/repository/compare`, {
      ...options,
      query: payload
    });
  }

  listCommits(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/repository/commits`, options);
  }

  getCommit(projectId: string, sha: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/repository/commits/${encode(sha)}`, options);
  }

  getCommitDiff(
    projectId: string,
    sha: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/repository/commits/${encode(sha)}/diff`,
      options
    );
  }

  // merge requests
  listMergeRequests(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/merge_requests`, options);
  }

  getMergeRequest(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}`,
      options
    );
  }

  createMergeRequest(
    projectId: string,
    payload: {
      source_branch: string;
      target_branch: string;
      title: string;
      description?: string;
      remove_source_branch?: boolean;
      squash?: boolean;
      draft?: boolean;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/merge_requests`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  updateMergeRequest(
    projectId: string,
    mergeRequestIid: string,
    payload: Record<string, unknown>,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(`/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  mergeMergeRequest(
    projectId: string,
    mergeRequestIid: string,
    payload: Record<string, unknown> = {},
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/merge`,
      {
        ...options,
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  getMergeRequestDiffs(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/changes`,
      options
    );
  }

  listMergeRequestDiffs(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/diffs`,
      options
    );
  }

  listMergeRequestVersions(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/versions`,
      options
    );
  }

  getMergeRequestVersion(
    projectId: string,
    mergeRequestIid: string,
    versionId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/versions/${encode(versionId)}`,
      options
    );
  }

  approveMergeRequest(
    projectId: string,
    mergeRequestIid: string,
    payload: Record<string, unknown> = {},
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/approve`,
      {
        ...options,
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  unapproveMergeRequest(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/unapprove`,
      {
        ...options,
        body: JSON.stringify({}),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  getMergeRequestApprovalState(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/approval_state`,
      options
    );
  }

  listMergeRequestDiscussions(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/discussions`,
      options
    );
  }

  createMergeRequestDiscussionNote(
    projectId: string,
    mergeRequestIid: string,
    discussionId: string,
    payload: {
      body: string;
      created_at?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/discussions/${encode(discussionId)}/notes`,
      {
        ...options,
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  createMergeRequestThread(
    projectId: string,
    mergeRequestIid: string,
    payload: {
      body: string;
      position?: Record<string, unknown>;
      created_at?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/discussions`,
      {
        ...options,
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  updateMergeRequestDiscussionNote(
    projectId: string,
    mergeRequestIid: string,
    discussionId: string,
    noteId: string,
    payload: {
      body?: string;
      resolved?: boolean;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/discussions/${encode(discussionId)}/notes/${encode(noteId)}`,
      {
        ...options,
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  deleteMergeRequestDiscussionNote(
    projectId: string,
    mergeRequestIid: string,
    discussionId: string,
    noteId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/discussions/${encode(discussionId)}/notes/${encode(noteId)}`,
      options
    );
  }

  resolveMergeRequestThread(
    projectId: string,
    mergeRequestIid: string,
    discussionId: string,
    noteId: string,
    resolved: boolean,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/discussions/${encode(discussionId)}/notes/${encode(noteId)}`,
      {
        ...options,
        body: JSON.stringify({ resolved }),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  listMergeRequestNotes(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/notes`,
      options
    );
  }

  getMergeRequestNote(
    projectId: string,
    mergeRequestIid: string,
    noteId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/notes/${encode(noteId)}`,
      options
    );
  }

  createMergeRequestNote(
    projectId: string,
    mergeRequestIid: string,
    body: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/notes`,
      {
        ...options,
        body: JSON.stringify({ body }),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  getDraftNote(
    projectId: string,
    mergeRequestIid: string,
    draftNoteId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/draft_notes/${encode(draftNoteId)}`,
      options
    );
  }

  listDraftNotes(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/draft_notes`,
      options
    );
  }

  createDraftNote(
    projectId: string,
    mergeRequestIid: string,
    payload: {
      body: string;
      position?: Record<string, unknown>;
      resolve_discussion?: boolean;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/draft_notes`,
      {
        ...options,
        body: JSON.stringify({
          note: payload.body,
          position: payload.position,
          resolve_discussion: payload.resolve_discussion
        }),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  updateDraftNote(
    projectId: string,
    mergeRequestIid: string,
    draftNoteId: string,
    payload: {
      body?: string;
      position?: Record<string, unknown>;
      resolve_discussion?: boolean;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/draft_notes/${encode(draftNoteId)}`,
      {
        ...options,
        body: JSON.stringify({
          note: payload.body,
          position: payload.position,
          resolve_discussion: payload.resolve_discussion
        }),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  deleteDraftNote(
    projectId: string,
    mergeRequestIid: string,
    draftNoteId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/draft_notes/${encode(draftNoteId)}`,
      options
    );
  }

  publishDraftNote(
    projectId: string,
    mergeRequestIid: string,
    draftNoteId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/draft_notes/${encode(draftNoteId)}/publish`,
      {
        ...options,
        body: JSON.stringify({}),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  bulkPublishDraftNotes(
    projectId: string,
    mergeRequestIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/draft_notes/bulk_publish`,
      {
        ...options,
        body: JSON.stringify({}),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  createNote(
    projectId: string,
    noteableType: "issue" | "merge_request",
    noteableIid: string,
    body: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/${noteableType}s/${encode(noteableIid)}/notes`,
      {
        ...options,
        body: JSON.stringify({ body }),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  updateMergeRequestNote(
    projectId: string,
    mergeRequestIid: string,
    noteId: string,
    body: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/notes/${encode(noteId)}`,
      {
        ...options,
        body: JSON.stringify({ body }),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  deleteMergeRequestNote(
    projectId: string,
    mergeRequestIid: string,
    noteId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(
      `/projects/${encode(projectId)}/merge_requests/${encode(mergeRequestIid)}/notes/${encode(noteId)}`,
      options
    );
  }

  // issues
  listIssues(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/issues`, options);
  }

  getIssue(
    projectId: string,
    issueIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/issues/${encode(issueIid)}`, options);
  }

  createIssue(
    projectId: string,
    payload: {
      title: string;
      description?: string;
      assignee_ids?: number[];
      labels?: string;
      milestone_id?: number;
      due_date?: string;
      confidential?: boolean;
      issue_type?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/issues`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  updateIssue(
    projectId: string,
    issueIid: string,
    payload: Record<string, unknown>,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(`/projects/${encode(projectId)}/issues/${encode(issueIid)}`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  deleteIssue(
    projectId: string,
    issueIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(`/projects/${encode(projectId)}/issues/${encode(issueIid)}`, options);
  }

  myIssues(
    payload: {
      project_id?: string;
      state?: "opened" | "closed" | "all";
      labels?: string;
      milestone?: string;
      search?: string;
      created_after?: string;
      created_before?: string;
      updated_after?: string;
      updated_before?: string;
      per_page?: number;
      page?: number;
      scope?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    const { project_id: projectId, ...queryPayload } = payload;
    const path = projectId ? `/projects/${encode(projectId)}/issues` : "/issues";

    return this.get(path, {
      ...options,
      query: {
        scope: queryPayload.scope ?? "assigned_to_me",
        ...queryPayload,
        ...(options.query ?? {})
      }
    });
  }

  listIssueDiscussions(
    projectId: string,
    issueIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/issues/${encode(issueIid)}/discussions`,
      options
    );
  }

  createIssueNote(
    projectId: string,
    issueIid: string,
    payload: {
      body: string;
      discussion_id?: string;
      created_at?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    const discussionPath = payload.discussion_id
      ? `/discussions/${encode(payload.discussion_id)}/notes`
      : "/notes";
    return this.post(`/projects/${encode(projectId)}/issues/${encode(issueIid)}${discussionPath}`, {
      ...options,
      body: JSON.stringify({
        body: payload.body,
        created_at: payload.created_at
      }),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  updateIssueNote(
    projectId: string,
    issueIid: string,
    discussionId: string,
    noteId: string,
    payload: {
      body?: string;
      resolved?: boolean;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(
      `/projects/${encode(projectId)}/issues/${encode(issueIid)}/discussions/${encode(discussionId)}/notes/${encode(noteId)}`,
      {
        ...options,
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          ...(options.headers ?? {})
        }
      }
    );
  }

  listIssueLinks(
    projectId: string,
    issueIid: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/issues/${encode(issueIid)}/links`, options);
  }

  getIssueLink(
    projectId: string,
    issueIid: string,
    issueLinkId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/issues/${encode(issueIid)}/links/${encode(issueLinkId)}`,
      options
    );
  }

  createIssueLink(
    projectId: string,
    issueIid: string,
    payload: {
      target_project_id: string;
      target_issue_iid: string;
      link_type?: "relates_to" | "blocks" | "is_blocked_by";
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/issues/${encode(issueIid)}/links`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  deleteIssueLink(
    projectId: string,
    issueIid: string,
    issueLinkId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(
      `/projects/${encode(projectId)}/issues/${encode(issueIid)}/links/${encode(issueLinkId)}`,
      options
    );
  }

  // wiki
  listWikiPages(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/wikis`, options);
  }

  getWikiPage(
    projectId: string,
    slug: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/wikis/${encode(slug)}`, options);
  }

  createWikiPage(
    projectId: string,
    payload: {
      title: string;
      content: string;
      format?: "markdown" | "rdoc" | "asciidoc" | "org";
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/wikis`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  updateWikiPage(
    projectId: string,
    slug: string,
    payload: {
      content: string;
      title?: string;
      format?: "markdown" | "rdoc" | "asciidoc" | "org";
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(`/projects/${encode(projectId)}/wikis/${encode(slug)}`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  deleteWikiPage(
    projectId: string,
    slug: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(`/projects/${encode(projectId)}/wikis/${encode(slug)}`, options);
  }

  // pipelines
  listPipelines(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/pipelines`, options);
  }

  getPipeline(
    projectId: string,
    pipelineId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/pipelines/${encode(pipelineId)}`, options);
  }

  listPipelineJobs(
    projectId: string,
    pipelineId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/pipelines/${encode(pipelineId)}/jobs`, options);
  }

  listPipelineTriggerJobs(
    projectId: string,
    pipelineId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/pipelines/${encode(pipelineId)}/bridges`,
      options
    );
  }

  getPipelineJob(
    projectId: string,
    jobId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/jobs/${encode(jobId)}`, options);
  }

  getPipelineJobOutput(
    projectId: string,
    jobId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/jobs/${encode(jobId)}/trace`, options);
  }

  createPipeline(
    projectId: string,
    payload: {
      ref: string;
      variables?: Array<{ key: string; value: string; variable_type?: "env_var" | "file" }>;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/pipeline`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  retryPipeline(
    projectId: string,
    pipelineId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/pipelines/${encode(pipelineId)}/retry`,
      options
    );
  }

  cancelPipeline(
    projectId: string,
    pipelineId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/pipelines/${encode(pipelineId)}/cancel`,
      options
    );
  }

  retryPipelineJob(
    projectId: string,
    jobId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/jobs/${encode(jobId)}/retry`, options);
  }

  cancelPipelineJob(
    projectId: string,
    jobId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/jobs/${encode(jobId)}/cancel`, options);
  }

  playPipelineJob(
    projectId: string,
    jobId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/jobs/${encode(jobId)}/play`, options);
  }

  // milestones
  listMilestones(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/milestones`, options);
  }

  getMilestone(
    projectId: string,
    milestoneId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/milestones/${encode(milestoneId)}`, options);
  }

  createMilestone(
    projectId: string,
    payload: {
      title: string;
      description?: string;
      due_date?: string;
      start_date?: string;
    },
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/milestones`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  updateMilestone(
    projectId: string,
    milestoneId: string,
    payload: Record<string, unknown>,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(`/projects/${encode(projectId)}/milestones/${encode(milestoneId)}`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  deleteMilestone(
    projectId: string,
    milestoneId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(`/projects/${encode(projectId)}/milestones/${encode(milestoneId)}`, options);
  }

  getMilestoneIssues(
    projectId: string,
    milestoneId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/milestones/${encode(milestoneId)}/issues`,
      options
    );
  }

  getMilestoneMergeRequests(
    projectId: string,
    milestoneId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/milestones/${encode(milestoneId)}/merge_requests`,
      options
    );
  }

  promoteMilestone(
    projectId: string,
    milestoneId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/milestones/${encode(milestoneId)}/promote`,
      options
    );
  }

  getMilestoneBurndownEvents(
    projectId: string,
    milestoneId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(
      `/projects/${encode(projectId)}/milestones/${encode(milestoneId)}/burndown_events`,
      options
    );
  }

  // releases
  listReleases(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/releases`, options);
  }

  getRelease(
    projectId: string,
    tagName: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/releases/${encode(tagName)}`, options);
  }

  createRelease(
    projectId: string,
    payload: Record<string, unknown>,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/releases`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  updateRelease(
    projectId: string,
    tagName: string,
    payload: Record<string, unknown>,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(`/projects/${encode(projectId)}/releases/${encode(tagName)}`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  deleteRelease(
    projectId: string,
    tagName: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(`/projects/${encode(projectId)}/releases/${encode(tagName)}`, options);
  }

  createReleaseEvidence(
    projectId: string,
    tagName: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(
      `/projects/${encode(projectId)}/releases/${encode(tagName)}/evidence`,
      options
    );
  }

  downloadReleaseAsset(
    projectId: string,
    tagName: string,
    directAssetPath: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    const safePath = encodeSlashPath(directAssetPath);
    return this.get(
      `/projects/${encode(projectId)}/releases/${encode(tagName)}/downloads/${safePath}`,
      options
    );
  }

  // labels
  listLabels(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/labels`, options);
  }

  getLabel(
    projectId: string,
    labelId: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/labels/${encode(labelId)}`, options);
  }

  createLabel(
    projectId: string,
    payload: Record<string, unknown>,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.post(`/projects/${encode(projectId)}/labels`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  updateLabel(
    projectId: string,
    payload: Record<string, unknown>,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.put(`/projects/${encode(projectId)}/labels`, {
      ...options,
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      }
    });
  }

  deleteLabel(
    projectId: string,
    labelName: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    return this.delete(`/projects/${encode(projectId)}/labels`, {
      ...options,
      query: {
        name: labelName,
        ...(options.query ?? {})
      }
    });
  }

  // namespaces/users/events
  listNamespaces(options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get("/namespaces", options);
  }

  listGroupIterations(groupId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/groups/${encode(groupId)}/iterations`, options);
  }

  getNamespace(namespaceIdOrPath: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/namespaces/${encode(namespaceIdOrPath)}`, options);
  }

  verifyNamespace(pathName: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/namespaces/${encode(pathName)}/exists`, options);
  }

  getUsers(options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get("/users", options);
  }

  listEvents(options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get("/events", options);
  }

  getProjectEvents(projectId: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.get(`/projects/${encode(projectId)}/events`, options);
  }

  // attachments / markdown
  uploadMarkdown(
    projectId: string,
    content: string,
    filename: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/markdown" }), filename);

    return this.post(`/projects/${encode(projectId)}/uploads`, {
      ...options,
      body: form,
      headers: {
        Accept: "*/*",
        ...(options.headers ?? {})
      }
    });
  }

  async uploadMarkdownFile(
    projectId: string,
    filePath: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    const content = await fs.readFile(filePath);
    const filename = path.basename(filePath);
    const form = new FormData();
    form.append("file", new Blob([content], { type: "application/octet-stream" }), filename);

    return this.post(`/projects/${encode(projectId)}/uploads`, {
      ...options,
      body: form,
      headers: {
        Accept: "*/*",
        ...(options.headers ?? {})
      }
    });
  }

  async downloadAttachment(
    urlOrPath: string,
    options: GitLabRequestOptions = {}
  ): Promise<{ fileName: string; contentType: string; base64: string }> {
    const requestConfig = this.resolveRequestConfig(options);
    const url = this.resolveAbsoluteUrl(urlOrPath, requestConfig.apiUrl);

    const headers = new Headers(options.headers);
    this.attachAuth(headers, requestConfig.token);

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) {
      throw new GitLabApiError(
        `GitLab attachment download failed: ${response.status} ${response.statusText}`,
        response.status,
        await this.parseResponseBody(response)
      );
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const disposition = response.headers.get("content-disposition") ?? "";
    const fileName = extractFileName(disposition) ?? `attachment-${Date.now()}`;
    const bytes = Buffer.from(await response.arrayBuffer());

    return {
      fileName,
      contentType,
      base64: bytes.toString("base64")
    };
  }

  // graphql
  executeGraphql(
    query: string,
    variables: Record<string, unknown> | undefined,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    const requestConfig = this.resolveRequestConfig(options);
    const endpoint = buildGraphqlEndpoint(requestConfig.apiUrl);

    return this.rawRequest(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {})
      },
      body: JSON.stringify({ query, variables }),
      token: requestConfig.token
    });
  }

  // generic methods
  get(path: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.request("GET", path, options);
  }

  post(path: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.request("POST", path, options);
  }

  put(path: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.request("PUT", path, options);
  }

  delete(path: string, options: GitLabRequestOptions = {}): Promise<unknown> {
    return this.request("DELETE", path, options);
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    options: GitLabRequestOptions = {}
  ): Promise<unknown> {
    const config = this.resolveRequestConfig(options);
    const url = new URL(path.replace(/^\//, ""), `${config.apiUrl}/`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return this.rawRequest(url, {
      method,
      body: options.body,
      headers: options.headers,
      token: config.token
    });
  }

  private async rawRequest(
    url: URL,
    options: {
      method: string;
      body?: BodyInit;
      headers?: HeadersInit;
      token?: string;
    }
  ): Promise<unknown> {
    let headers = new Headers(options.headers);
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    let requestBody = options.body;
    let token = options.token;
    let fetchImpl: typeof fetch = fetch;

    if (this.beforeRequest) {
      const override = await this.beforeRequest({
        url,
        method: options.method,
        headers,
        body: requestBody,
        token
      });

      if (override?.headers) {
        headers = override.headers;
      }
      if (override?.body !== undefined) {
        requestBody = override.body;
      }
      if (override?.token !== undefined) {
        token = override.token;
      }
      if (override?.fetchImpl) {
        fetchImpl = override.fetchImpl;
      }
    }

    this.attachAuth(headers, token);

    const response = await fetchImpl(url, {
      method: options.method,
      body: requestBody,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    const body = await this.parseResponseBody(response);

    if (!response.ok) {
      throw new GitLabApiError(
        `GitLab API request failed: ${response.status} ${response.statusText}`,
        response.status,
        body
      );
    }

    return body;
  }

  private async parseResponseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      return response.json();
    }

    return response.text();
  }

  private resolveRequestConfig(options: GitLabRequestOptions): { apiUrl: string; token?: string } {
    const sessionAuth = getSessionAuth();
    const apiUrl = options.apiUrl ?? sessionAuth?.apiUrl ?? this.pickApiUrl();
    const token = options.token ?? sessionAuth?.token ?? this.defaultToken;

    return {
      apiUrl: normalizeApiUrl(apiUrl),
      token
    };
  }

  private pickApiUrl(): string {
    if (this.apiUrls.length <= 1) {
      return this.baseApiUrl;
    }

    const index = this.nextApiUrlIndex % this.apiUrls.length;
    this.nextApiUrlIndex = (this.nextApiUrlIndex + 1) % this.apiUrls.length;
    return this.apiUrls[index] ?? this.baseApiUrl;
  }

  private resolveAbsoluteUrl(raw: string, apiUrl: string): URL {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw);
    }

    const base = new URL(apiUrl);
    return new URL(raw.replace(/^\//, ""), `${base.origin}/`);
  }

  private attachAuth(headers: Headers, token?: string): void {
    if (!token) {
      return;
    }

    headers.set("PRIVATE-TOKEN", token);
  }
}

export function getEffectiveSessionAuth(
  defaultToken?: string,
  defaultApiUrl?: string
): SessionAuth {
  const auth = getSessionAuth();

  return {
    token: auth?.token ?? defaultToken,
    apiUrl: auth?.apiUrl ?? defaultApiUrl,
    header: auth?.header,
    sessionId: auth?.sessionId,
    updatedAt: auth?.updatedAt ?? Date.now()
  };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function encodeSlashPath(pathValue: string): string {
  const trimmed = pathValue.replace(/^\/+/, "").trim();
  if (!trimmed) {
    return "";
  }

  return trimmed
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encode(segment))
    .join("/");
}

function normalizeApiUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const pathname = url.pathname.replace(/\/+$/, "");

  if (pathname.endsWith("/api/v4")) {
    url.pathname = pathname;
    return url.toString();
  }

  url.pathname = `${pathname}/api/v4`.replace(/\/\//g, "/");

  return url.toString();
}

function buildGraphqlEndpoint(apiUrl: string): URL {
  const url = new URL(apiUrl);
  const prefix = url.pathname.replace(/\/api\/v4\/?$/, "");
  return new URL(`${prefix || "/"}/api/graphql`, url.origin);
}

function extractFileName(contentDisposition: string): string | undefined {
  const quoted = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(contentDisposition);

  if (!quoted) {
    return undefined;
  }

  return decodeURIComponent(quoted[1] ?? "");
}
