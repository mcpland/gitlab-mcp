/**
 * GitLab project type
 */
export interface GitLabProject {
  id: number;
  name: string;
  description: string | null;
  web_url: string;
  path_with_namespace: string;
  default_branch: string;
}

/**
 * GitLab merge request type
 */
export interface GitLabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: "opened" | "closed" | "locked" | "merged";
  created_at: string;
  updated_at: string;
  source_branch: string;
  target_branch: string;
  web_url: string;
}

/**
 * GitLab user type
 */
export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  state: string;
  avatar_url: string | null;
  web_url: string;
}

/**
 * GitLab repository type
 */
export interface GitLabRepository {
  id: number;
  name: string;
  url: string;
  description: string | null;
  homepage: string;
}

/**
 * GitLab commit type
 */
export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  created_at: string;
  web_url: string;
}
