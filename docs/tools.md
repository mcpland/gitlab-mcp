# Tools Reference

This document lists all MCP tools provided by gitlab-mcp. Each tool is prefixed with `gitlab_` (except `health_check`). Tools marked as **mutating** are disabled when `GITLAB_READ_ONLY_MODE=true`.

All project-scoped tools accept an optional `project_id` parameter. When `GITLAB_ALLOWED_PROJECT_IDS` is configured with a single project, `project_id` is automatically inferred.

Most list endpoints support `page` and `per_page`. Notable exceptions are `gitlab_list_merge_request_versions` and `gitlab_list_draft_notes`.

---

## Health

| Tool           | Mutating | Description                                   |
| -------------- | -------- | --------------------------------------------- |
| `health_check` | No       | Return server liveness and current timestamp. |

---

## Projects & Organization

| Tool                           | Mutating | Description                                                                                                                                   |
| ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_get_project`           | No       | Get project details by ID or path.                                                                                                            |
| `gitlab_list_projects`         | No       | List projects available to the current user. Supports `search`, `visibility`, `membership`, `owned`, `archived`, `order_by`, `sort`.          |
| `gitlab_create_repository`     | **Yes**  | Create a new GitLab project. Params: `name`, `description`, `visibility`, `initialize_with_readme`, `path`, `namespace_id`, `default_branch`. |
| `gitlab_fork_repository`       | **Yes**  | Fork a project to another namespace. Params: `namespace`, `namespace_id`, `path`, `name`, `description`, `visibility`, `default_branch`.      |
| `gitlab_list_project_members`  | No       | List members of a project. Supports `query`, `user_ids`, `skip_users`, `include_inheritance`.                                                 |
| `gitlab_list_group_projects`   | No       | List projects under a group. Params: `group_id` (required). Supports `include_subgroups`, `search`, filters.                                  |
| `gitlab_list_group_iterations` | No       | List iterations for a group. Params: `group_id` (required). Supports `state`, `search`, date filters.                                         |
| `gitlab_search_repositories`   | No       | Search repositories by keyword. Params: `search` (required).                                                                                  |

---

## Users & Namespaces

| Tool                      | Mutating | Description                                                                      |
| ------------------------- | -------- | -------------------------------------------------------------------------------- |
| `gitlab_get_users`        | No       | Search users. Supports `username`, `search`, `active`, `extern_uid`, `provider`. |
| `gitlab_list_namespaces`  | No       | List namespaces visible to user. Supports `search`, `owned`.                     |
| `gitlab_get_namespace`    | No       | Get namespace by ID or path. Params: `namespace_id_or_path` or `namespace_id`.   |
| `gitlab_verify_namespace` | No       | Verify if a namespace path exists. Params: `path` (required).                    |

---

## Events

| Tool                        | Mutating | Description                                                                                     |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `gitlab_list_events`        | No       | List current user events. Supports `action`, `target_type`, `before`, `after`, `scope`, `sort`. |
| `gitlab_get_project_events` | No       | List events for a specific project. Same filters as `list_events`.                              |

---

## Repository & Files

| Tool                           | Mutating | Description                                                                                                                                                                                        |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_get_repository_tree`   | No       | List files and directories. Supports `path`, `ref`, `recursive`.                                                                                                                                   |
| `gitlab_get_file_contents`     | No       | Get file by path and ref. Params: `file_path` (required), `ref` (defaults to project's default branch).                                                                                            |
| `gitlab_create_or_update_file` | **Yes**  | Create or update a single file. Params: `file_path`, `branch`, `content`, `commit_message` (all required). Supports `encoding`, `author_email`, `author_name`, `start_branch`, `last_commit_id`.   |
| `gitlab_push_files`            | **Yes**  | Create a commit with multiple file actions. Params: `branch`, `commit_message` (required), `actions` array (each with `action`, `file_path`, `content`, etc.). Also accepts legacy `files` format. |
| `gitlab_create_branch`         | **Yes**  | Create a new branch. Params: `branch` (required), `ref` (defaults to default branch).                                                                                                              |
| `gitlab_get_branch_diffs`      | No       | Compare two branches/refs and return diffs. Params: `from`, `to` (required), `straight`, `excluded_file_patterns`.                                                                                 |
| `gitlab_search_code_blobs`     | No       | Search code in a project. Params: `search` (required), `ref`.                                                                                                                                      |

---

## Commits

| Tool                     | Mutating | Description                                                                                          |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `gitlab_list_commits`    | No       | List commits. Supports `ref_name`, `since`, `until`, `path`, `author`, `all`, `with_stats`, `order`. |
| `gitlab_get_commit`      | No       | Get one commit by SHA. Params: `sha` (required), `stats`.                                            |
| `gitlab_get_commit_diff` | No       | Get diff for one commit. Params: `sha` (required), `full_diff`.                                      |

---

## Merge Requests

| Tool                                 | Mutating | Description                                                                                                                                                                                                                               |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_merge_requests`         | No       | List MRs. When `project_id` is omitted, lists globally. Supports `assignee_id`, `author_id`, `reviewer_id`, `state`, `labels`, `milestone`, `source_branch`, `target_branch`, `scope`, `order_by`, `sort`, date filters, `search`, `wip`. |
| `gitlab_get_merge_request`           | No       | Get one MR. Params: `merge_request_iid` or `source_branch`.                                                                                                                                                                               |
| `gitlab_create_merge_request`        | **Yes**  | Create an MR. Params: `source_branch`, `target_branch`, `title` (required). Supports `description`, `assignee_ids`, `reviewer_ids`, `labels`, `draft`, `squash`, `remove_source_branch`.                                                  |
| `gitlab_update_merge_request`        | **Yes**  | Update MR fields. Params: `merge_request_iid` (required). Supports `title`, `description`, `target_branch`, `state_event`, `labels`, `assignee_ids`, `reviewer_ids`, `draft`, `squash`.                                                   |
| `gitlab_merge_merge_request`         | **Yes**  | Merge an MR. Accepts `merge_request_iid` or `source_branch`. Supports `merge_commit_message`, `squash_commit_message`, `squash`, `should_remove_source_branch`, `merge_when_pipeline_succeeds`.                                           |
| `gitlab_get_merge_request_diffs`     | No       | Get MR diffs with changed files. Supports `view` (`inline`/`parallel`), `excluded_file_patterns`.                                                                                                                                         |
| `gitlab_list_merge_request_diffs`    | No       | List detailed MR diffs (versions/changes view). Supports `unidiff`.                                                                                                                                                                       |
| `gitlab_list_merge_request_versions` | No       | List MR diff versions.                                                                                                                                                                                                                    |
| `gitlab_get_merge_request_version`   | No       | Get one MR diff version. Params: `version_id` (required), `unidiff`.                                                                                                                                                                      |

### MR Code Context

| Tool                                    | Mutating | Description                                                    |
| --------------------------------------- | -------- | -------------------------------------------------------------- |
| `gitlab_get_merge_request_code_context` | No       | High-signal MR code context with filtering and budget control. |

**Parameters:**

| Parameter           | Type     | Default         | Description                                                                                             |
| ------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `merge_request_iid` | string   | —               | **Required.** MR IID.                                                                                   |
| `include_paths`     | string[] | —               | Glob patterns for files to include.                                                                     |
| `exclude_paths`     | string[] | —               | Glob patterns for files to exclude.                                                                     |
| `extensions`        | string[] | —               | File extension filter (e.g. `.ts`, `.py`).                                                              |
| `languages`         | string[] | —               | Language filter (e.g. `typescript`, `python`, `go`). Maps to extensions automatically.                  |
| `max_files`         | number   | `30`            | Maximum number of files to process (1–500).                                                             |
| `max_total_chars`   | number   | `120000`        | Character budget (500–2,000,000). Stops fetching when budget is exhausted.                              |
| `context_lines`     | number   | `20`            | Lines of context around changes (0–200). Used in `surrounding` mode.                                    |
| `mode`              | enum     | `patch`         | Content mode: `patch` (raw diff), `surrounding` (changed lines with context), `fullfile` (entire file). |
| `sort`              | enum     | `changed_lines` | Sort files by: `changed_lines`, `path`, `file_size`.                                                    |
| `list_only`         | boolean  | `false`         | If `true`, returns file list without content (for two-stage retrieval).                                 |

**Supported languages:** typescript, javascript, python, go, rust, java, kotlin, csharp, cpp, c, ruby, php, swift, scala, shell, yaml, json, markdown.

### MR Approvals

| Tool                                      | Mutating | Description                                         |
| ----------------------------------------- | -------- | --------------------------------------------------- |
| `gitlab_approve_merge_request`            | **Yes**  | Approve an MR. Supports `sha`, `approval_password`. |
| `gitlab_unapprove_merge_request`          | **Yes**  | Remove current user's approval from an MR.          |
| `gitlab_get_merge_request_approval_state` | No       | Get approval state for an MR.                       |

---

## MR Discussions

| Tool                                          | Mutating | Description                                                                                                       |
| --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_merge_request_discussions`       | No       | List MR discussions.                                                                                              |
| `gitlab_mr_discussions`                       | No       | Alias of `list_merge_request_discussions`.                                                                        |
| `gitlab_create_merge_request_thread`          | **Yes**  | Create a new discussion thread. Params: `body` (required). Supports `position` (for diff comments), `created_at`. |
| `gitlab_create_merge_request_discussion_note` | **Yes**  | Reply to an existing discussion thread. Params: `discussion_id`, `body` (required).                               |
| `gitlab_update_merge_request_discussion_note` | **Yes**  | Update a discussion note. Provide either `body` or `resolved` (not both).                                         |
| `gitlab_delete_merge_request_discussion_note` | **Yes**  | Delete a note from a discussion thread.                                                                           |
| `gitlab_resolve_merge_request_thread`         | **Yes**  | Resolve/unresolve a discussion note. Params: `discussion_id`, `note_id`, `resolved` (default `true`).             |

---

## MR Notes (Comments)

| Tool                               | Mutating | Description                                                                                                            |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_merge_request_notes`  | No       | List top-level MR notes. Supports `sort`, `order_by`.                                                                  |
| `gitlab_get_merge_request_notes`   | No       | Alias of `list_merge_request_notes`.                                                                                   |
| `gitlab_get_merge_request_note`    | No       | Get a single MR note by ID.                                                                                            |
| `gitlab_create_merge_request_note` | **Yes**  | Create a top-level MR comment. Params: `body` (required).                                                              |
| `gitlab_update_merge_request_note` | **Yes**  | Update MR note body. Params: `note_id`, `body` (required).                                                             |
| `gitlab_delete_merge_request_note` | **Yes**  | Delete an MR note.                                                                                                     |
| `gitlab_create_note`               | **Yes**  | Create a note on an issue or MR. Params: `noteable_type` (`issue`/`merge_request`), `noteable_iid`, `body` (required). |

---

## Draft Notes

| Tool                              | Mutating | Description                                                                                |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `gitlab_get_draft_note`           | No       | Get a single draft note.                                                                   |
| `gitlab_list_draft_notes`         | No       | List draft notes on an MR.                                                                 |
| `gitlab_create_draft_note`        | **Yes**  | Create a draft note. Params: `body` (required). Supports `position`, `resolve_discussion`. |
| `gitlab_update_draft_note`        | **Yes**  | Update a draft note. At least one of `body`, `position`, or `resolve_discussion` required. |
| `gitlab_delete_draft_note`        | **Yes**  | Delete a draft note.                                                                       |
| `gitlab_publish_draft_note`       | **Yes**  | Publish one draft note.                                                                    |
| `gitlab_bulk_publish_draft_notes` | **Yes**  | Publish all draft notes on an MR.                                                          |

---

## Issues

| Tool                            | Mutating | Description                                                                                                                                                                                    |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_issues`            | No       | List issues. When `project_id` is omitted, lists globally. Supports `assignee_id`, `author_id`, `state`, `labels`, `milestone`, `scope`, `search`, `issue_type`, `confidential`, date filters. |
| `gitlab_my_issues`              | No       | List issues assigned to the current user. Supports `state`, `labels`, `search`, date filters.                                                                                                  |
| `gitlab_get_issue`              | No       | Get issue by IID.                                                                                                                                                                              |
| `gitlab_create_issue`           | **Yes**  | Create an issue. Params: `title` (required). Supports `description`, `labels`, `milestone_id`, `due_date`, `confidential`, `issue_type`, `assignee_ids`.                                       |
| `gitlab_update_issue`           | **Yes**  | Update issue fields. Supports `title`, `description`, `state_event`, `labels`, `assignee_ids`, `weight`, `issue_type`, `discussion_locked`.                                                    |
| `gitlab_delete_issue`           | **Yes**  | Delete an issue.                                                                                                                                                                               |
| `gitlab_list_issue_discussions` | No       | List issue discussions.                                                                                                                                                                        |
| `gitlab_create_issue_note`      | **Yes**  | Create issue comment. Params: `body` (required). Supports `discussion_id` (to reply to thread), `created_at`.                                                                                  |
| `gitlab_update_issue_note`      | **Yes**  | Update an issue note. Provide either `body` or `resolved` (not both).                                                                                                                          |

### Issue Links

| Tool                       | Mutating | Description                                                                                                                                                       |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_issue_links`  | No       | List related issue links.                                                                                                                                         |
| `gitlab_get_issue_link`    | No       | Get a single issue link by ID.                                                                                                                                    |
| `gitlab_create_issue_link` | **Yes**  | Create a relation between two issues. Params: `target_project_id`, `target_issue_iid` (required). Supports `link_type` (`relates_to`, `blocks`, `is_blocked_by`). |
| `gitlab_delete_issue_link` | **Yes**  | Delete a relation between issues.                                                                                                                                 |

---

## Wiki

Requires `USE_GITLAB_WIKI=true` (default).

| Tool                      | Mutating | Description                                                                                                           |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_wiki_pages`  | No       | List wiki pages. Supports `with_content`.                                                                             |
| `gitlab_get_wiki_page`    | No       | Get wiki page by slug. Supports `version`.                                                                            |
| `gitlab_create_wiki_page` | **Yes**  | Create a wiki page. Params: `title`, `content` (required). Supports `format` (`markdown`, `rdoc`, `asciidoc`, `org`). |
| `gitlab_update_wiki_page` | **Yes**  | Update wiki page by slug. Params: `slug`, `content` (required). Supports `title`, `format`.                           |
| `gitlab_delete_wiki_page` | **Yes**  | Delete wiki page by slug.                                                                                             |

---

## Pipelines & Jobs

Requires `USE_PIPELINE=true` (default).

| Tool                                | Mutating | Description                                                                                                       |
| ----------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_pipelines`             | No       | List pipelines. Supports `scope`, `status`, `ref`, `sha`, `username`, `source`, `order_by`, `sort`, date filters. |
| `gitlab_get_pipeline`               | No       | Get one pipeline by ID.                                                                                           |
| `gitlab_list_pipeline_jobs`         | No       | List jobs in a pipeline. Supports `scope`, `include_retried`.                                                     |
| `gitlab_list_pipeline_trigger_jobs` | No       | List downstream/bridge trigger jobs in a pipeline.                                                                |
| `gitlab_get_pipeline_job`           | No       | Get one job by ID.                                                                                                |
| `gitlab_get_pipeline_job_output`    | No       | Get raw job trace/log output.                                                                                     |
| `gitlab_create_pipeline`            | **Yes**  | Trigger a new pipeline. Params: `ref` (required). Supports `variables` array (`key`, `value`, `variable_type`).   |
| `gitlab_retry_pipeline`             | **Yes**  | Retry failed jobs in a pipeline.                                                                                  |
| `gitlab_cancel_pipeline`            | **Yes**  | Cancel a running pipeline.                                                                                        |
| `gitlab_retry_pipeline_job`         | **Yes**  | Retry one failed job.                                                                                             |
| `gitlab_cancel_pipeline_job`        | **Yes**  | Cancel one running job.                                                                                           |
| `gitlab_play_pipeline_job`          | **Yes**  | Play/trigger a manual job.                                                                                        |

---

## Milestones

Requires `USE_MILESTONE=true` (default).

| Tool                                   | Mutating | Description                                                                                              |
| -------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `gitlab_list_milestones`               | No       | List project milestones. Supports `iids`, `state`, `title`, `search`, `include_ancestors`, date filters. |
| `gitlab_get_milestone`                 | No       | Get a milestone by ID.                                                                                   |
| `gitlab_create_milestone`              | **Yes**  | Create a milestone. Params: `title` (required). Supports `description`, `due_date`, `start_date`.        |
| `gitlab_update_milestone`              | **Yes**  | Update milestone fields.                                                                                 |
| `gitlab_edit_milestone`                | **Yes**  | Alias of `update_milestone`.                                                                             |
| `gitlab_delete_milestone`              | **Yes**  | Delete a milestone.                                                                                      |
| `gitlab_get_milestone_issue`           | No       | List issues assigned to a milestone.                                                                     |
| `gitlab_get_milestone_merge_requests`  | No       | List MRs assigned to a milestone.                                                                        |
| `gitlab_promote_milestone`             | **Yes**  | Promote a project milestone to a group milestone.                                                        |
| `gitlab_get_milestone_burndown_events` | No       | List burndown events for a milestone.                                                                    |

---

## Releases

Requires `USE_RELEASE=true` (default).

| Tool                             | Mutating | Description                                                                                                                                   |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_releases`           | No       | List project releases. Supports `order_by`, `sort`, `include_html_description`.                                                               |
| `gitlab_get_release`             | No       | Get one release by tag name.                                                                                                                  |
| `gitlab_create_release`          | **Yes**  | Create a release. Params: `tag_name` (required). Supports `name`, `tag_message`, `description`, `ref`, `released_at`, `milestones`, `assets`. |
| `gitlab_update_release`          | **Yes**  | Update existing release.                                                                                                                      |
| `gitlab_delete_release`          | **Yes**  | Delete a release by tag.                                                                                                                      |
| `gitlab_create_release_evidence` | **Yes**  | Create evidence for an existing release.                                                                                                      |
| `gitlab_download_release_asset`  | No       | Download a release asset. Params: `tag_name`, `direct_asset_path` (required).                                                                 |

---

## Labels

| Tool                  | Mutating | Description                                                                                                |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `gitlab_list_labels`  | No       | List project labels. Supports `with_counts`, `include_ancestor_groups`, `search`.                          |
| `gitlab_get_label`    | No       | Get one label by ID. Supports `include_ancestor_groups`.                                                   |
| `gitlab_create_label` | **Yes**  | Create a label. Params: `name`, `color` (required). Supports `description`, `priority`.                    |
| `gitlab_update_label` | **Yes**  | Update a label. Identify by `name` or `label_id`. Supports `new_name`, `color`, `description`, `priority`. |
| `gitlab_delete_label` | **Yes**  | Delete a label. Identify by `name` or `label_id`.                                                          |

---

## Uploads & Attachments

| Tool                         | Mutating | Description                                                                                                                                                                           |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_upload_markdown`     | **Yes**  | Upload markdown file/attachment to project. Provide either `file_path` (local file) or `content` with `filename`.                                                                     |
| `gitlab_download_attachment` | No       | Download attachment. Provide either `url_or_path` or both `secret` and `filename`. Absolute `url_or_path` must be same-origin with configured GitLab API URL. Returns base64 content. |

---

## GraphQL

| Tool                              | Mutating | Description                                                                                  |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `gitlab_execute_graphql_query`    | No       | Execute a read-only GraphQL query. Rejects mutations.                                        |
| `gitlab_execute_graphql_mutation` | **Yes**  | Execute a GraphQL mutation. Disabled in read-only mode.                                      |
| `gitlab_execute_graphql`          | No\*     | Backward-compatible executor. Automatically detects mutations and enforces read-only policy. |

\* `gitlab_execute_graphql` is registered as non-mutating but dynamically checks mutation content against the policy engine at execution time.
