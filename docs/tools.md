# Tools Reference

This document lists all MCP tools provided by gitlab-mcp. Each tool is prefixed with `gitlab_` (except `health_check`). The **Mutating** column is a legacy shorthand for read-only mode visibility; runtime policy additionally classifies tools by capability (`read`, `write`, `delete`, `admin`, `graphql`).

All project-scoped tools accept an optional `project_id` parameter. When `GITLAB_ALLOWED_PROJECT_IDS` is configured with a single project, `project_id` is automatically inferred.

Most list endpoints support `page` and `per_page`. Notable exceptions are `gitlab_list_merge_request_versions` and `gitlab_list_draft_notes`.

---

## Health

| Tool           | Mutating | Description                                   |
| -------------- | -------- | --------------------------------------------- |
| `health_check` | No       | Return server liveness and current timestamp. |

---

## Projects & Organization

| Tool                           | Mutating | Description                                                                                                                                                                                  |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_get_project`           | No       | Get project details by ID or path.                                                                                                                                                           |
| `gitlab_list_projects`         | No       | List projects available to the current user. Supports `search`, `topic`, `visibility`, `membership`, `owned`, `archived`, `order_by`, `sort`.                                                |
| `gitlab_update_project`        | **Yes**  | Update allowlisted metadata, merge defaults, and feature access levels. Supports `name`, `description`, `visibility`, `topics`, merge policy fields, and documented `*_access_level` fields. |
| `gitlab_create_repository`     | **Yes**  | Create a new GitLab project. Params: `name`, `description`, `visibility`, `initialize_with_readme`, `path`, `namespace_id`, `default_branch`.                                                |
| `gitlab_create_group`          | **Yes**  | Create a new GitLab group or subgroup. Params: `name`, `path` (required). Supports `description`, `visibility`, `parent_id`.                                                                 |
| `gitlab_fork_repository`       | **Yes**  | Fork a project to another namespace. Params: `namespace`, `namespace_id`, `path`, `name`, `description`, `visibility`, `default_branch`.                                                     |
| `gitlab_list_project_members`  | No       | List members of a project. Supports `query`, `user_ids`, `skip_users`, `include_inheritance`.                                                                                                |
| `gitlab_list_group_projects`   | No       | List projects under a group. Params: `group_id` (required). Supports `include_subgroups`, `search`, `topic`, filters.                                                                        |
| `gitlab_list_group_iterations` | No       | List iterations for a group. Params: `group_id` (required). Supports `state`, `search`, date filters.                                                                                        |
| `gitlab_search_repositories`   | No       | Search repositories by keyword. Params: `search` (required).                                                                                                                                 |
| `gitlab_search_code`           | No       | Search code globally. Params: `search` (required). Supports `filename`, `path`, `extension`, pagination.                                                                                     |
| `gitlab_search_project_code`   | No       | Search code in a project. Params: `project_id`, `search` (required). Supports `ref`, `filename`, `path`, `extension`, pagination.                                                            |
| `gitlab_search_group_code`     | No       | Search code in a group. Params: `group_id`, `search` (required). Supports `filename`, `path`, `extension`, pagination.                                                                       |

`gitlab_update_project` accepts only: `name`, `description`, `visibility`, `topics`, `request_access_enabled`, `remove_source_branch_after_merge`, `only_allow_merge_if_pipeline_succeeds`, `only_allow_merge_if_all_discussions_are_resolved`, `squash_option`, `merge_method`, `issues_access_level`, `merge_requests_access_level`, `builds_access_level`, `wiki_access_level`, `snippets_access_level`, `container_registry_access_level`, `environments_access_level`, `forking_access_level`, `package_registry_access_level`, and `pages_access_level`. Other GitLab project-update fields are rejected. Use `gitlab_update_default_branch` for the default branch.

---

## Users & Namespaces

| Tool                      | Mutating | Description                                                                                               |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `gitlab_get_users`        | No       | Search users. Supports `username`, `search`, `active`, `extern_uid`, `provider`.                          |
| `gitlab_get_user`         | No       | Get one user by ID. Params: `user_id` (required).                                                         |
| `gitlab_whoami`           | No       | Get the current authenticated user.                                                                       |
| `gitlab_list_namespaces`  | No       | List namespaces visible to user. Supports `search`, `owned`.                                              |
| `gitlab_get_namespace`    | No       | Get namespace by ID or path. Params: `namespace_id_or_path` or `namespace_id`.                            |
| `gitlab_verify_namespace` | No       | Verify if a namespace path exists. Params: `path` (required), optional `parent_id` for nested namespaces. |

---

## Events

| Tool                        | Mutating | Description                                                                                     |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `gitlab_list_events`        | No       | List current user events. Supports `action`, `target_type`, `before`, `after`, `scope`, `sort`. |
| `gitlab_get_project_events` | No       | List events for a specific project. Same filters as `list_events`.                              |

---

## Webhooks

| Tool                         | Mutating | Description                                                                                                 |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `gitlab_list_webhooks`       | No       | List webhooks for exactly one `project_id` or `group_id`. Supports pagination.                              |
| `gitlab_list_webhook_events` | No       | List recent webhook events for `hook_id`. Supports `status`, `summary`, `page`, `per_page` (max 20).        |
| `gitlab_get_webhook_event`   | No       | Find one webhook event by `event_id`. Supports direct `page`; otherwise scans up to 500 most recent events. |

---

## Repository & Files

| Tool                             | Mutating | Description                                                                                                                                                                                        |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_get_repository_tree`     | No       | List files and directories. Supports `path`, `ref`, `recursive`, and pagination. Keyset responses include `next_page_token` when GitLab returns one.                                               |
| `gitlab_get_file_contents`       | No       | Get file by path and ref. Params: `file_path` (required), `ref` (defaults to project's default branch). Set `decode_base64` to return UTF-8 text for GitLab base64 file payloads.                  |
| `gitlab_get_file_blame`          | No       | Get git blame for a file. Params: `file_path`, `ref` (required). Supports paired `range_start` and `range_end`.                                                                                    |
| `gitlab_create_or_update_file`   | **Yes**  | Create or update a single file. Params: `file_path`, `branch`, `content`, `commit_message` (all required). Supports `encoding`, `author_email`, `author_name`, `start_branch`, `last_commit_id`.   |
| `gitlab_push_files`              | **Yes**  | Create a commit with multiple file actions. Params: `branch`, `commit_message` (required), `actions` array (each with `action`, `file_path`, `content`, etc.). Also accepts legacy `files` format. |
| `gitlab_create_branch`           | **Yes**  | Create a new branch. Params: `branch` (required), `ref` (defaults to default branch).                                                                                                              |
| `gitlab_list_branches`           | No       | List repository branches. Supports `search`, `regex`, `sort`, and pagination.                                                                                                                      |
| `gitlab_get_branch`              | No       | Get details for one branch. Params: `branch` (required).                                                                                                                                           |
| `gitlab_list_protected_branches` | No       | List protected branch rules. Supports `search` and pagination.                                                                                                                                     |
| `gitlab_get_protected_branch`    | No       | Get one protected branch or wildcard rule. Params: `branch` (required).                                                                                                                            |
| `gitlab_protect_branch`          | **Yes**  | Protect a branch or wildcard. Supports role access levels `0` (push/merge only), `30`, `40`, `60`; force-push and Code Owner controls.                                                             |
| `gitlab_unprotect_branch`        | **Yes**  | Remove a branch or wildcard protection rule. Params: `branch` (required).                                                                                                                          |
| `gitlab_update_default_branch`   | **Yes**  | Change the project default branch. Params: `default_branch` (required).                                                                                                                            |
| `gitlab_delete_branch`           | **Yes**  | Delete a repository branch. Params: `branch` (required).                                                                                                                                           |
| `gitlab_get_branch_diffs`        | No       | Compare two branches/refs and return diffs. Params: `from`, `to` (required), `straight`, `excluded_file_patterns`.                                                                                 |
| `gitlab_search_code_blobs`       | No       | Search code in a project. Params: `search` (required), `ref`. Also supports `filename`, `path`, `extension`.                                                                                       |

---

## Commits

| Tool                          | Mutating | Description                                                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gitlab_list_commits`         | No       | List commits. Supports `ref_name`, `since`, `until`, `path`, `author`, `all`, `with_stats`, `order`.                                             |
| `gitlab_get_commit`           | No       | Get one commit by SHA. Params: `sha` (required), `stats`.                                                                                        |
| `gitlab_get_commit_diff`      | No       | Get diff for one commit. Params: `sha` (required), `full_diff`.                                                                                  |
| `gitlab_list_commit_statuses` | No       | List statuses for a commit. Params: `sha` (required). Supports `ref`, `stage`, `name`, `pipeline_id`, `all`, sorting, and pagination.            |
| `gitlab_create_commit_status` | **Yes**  | Create or update commit status. Params: `sha`, `state` (required). Supports `ref`, `name` or `context`, `target_url`, `description`, `coverage`. |

---

## Merge Requests

| Tool                                      | Mutating | Description                                                                                                                                                                                                                           |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_merge_requests`              | No       | List MRs. When `project_id` is omitted, lists globally. Supports ID/username filters for assignee, author, reviewer, and approvers (`approved_by_usernames`), plus state, labels, branches, scope, sorting, date filters, and search. |
| `gitlab_get_merge_request`                | No       | Get one MR. Params: `merge_request_iid` or `source_branch`; set `include_summaries=true` for commit-addition and approval summaries (extra API calls).                                                                                |
| `gitlab_list_merge_request_pipelines`     | No       | List pipelines associated with an MR. Params: `merge_request_iid` (required), supports pagination.                                                                                                                                    |
| `gitlab_create_merge_request`             | **Yes**  | Create an MR. Params: `source_branch`, `target_branch`, `title` (required). Supports `description`, `assignee_ids`, `reviewer_ids`, `labels`, `draft`, `squash`, `remove_source_branch`.                                              |
| `gitlab_update_merge_request`             | **Yes**  | Update MR fields. Params: `merge_request_iid` (required). Supports `title`, `description`, `target_branch`, `state_event`, `labels`, `assignee_ids`, `reviewer_ids`, `draft`, `squash`.                                               |
| `gitlab_merge_merge_request`              | **Yes**  | Merge an MR. Accepts `merge_request_iid` or `source_branch`. Supports `merge_commit_message`, `squash_commit_message`, `squash`, `should_remove_source_branch`, `merge_when_pipeline_succeeds`.                                       |
| `gitlab_get_merge_request_diffs`          | No       | Get MR diffs with changed files. Supports `view` (`inline`/`parallel`), `excluded_file_patterns`.                                                                                                                                     |
| `gitlab_list_merge_request_changed_files` | No       | Step 1 for large MR review: list changed file paths and flags without diff content. Supports `merge_request_iid` or `source_branch`, plus `excluded_file_patterns`.                                                                   |
| `gitlab_list_merge_request_diffs`         | No       | List detailed MR diffs (versions/changes view). Supports `unidiff`.                                                                                                                                                                   |
| `gitlab_get_merge_request_file_diff`      | No       | Step 2 for large MR review: fetch diffs for specific `file_paths`. Supports batching and `unidiff`.                                                                                                                                   |
| `gitlab_list_merge_request_versions`      | No       | List MR diff versions.                                                                                                                                                                                                                |
| `gitlab_get_merge_request_version`        | No       | Get one MR diff version. Params: `version_id` (required), `unidiff`.                                                                                                                                                                  |
| `gitlab_get_merge_request_conflicts`      | No       | Get merge request conflict details from GitLab's conflicts endpoint.                                                                                                                                                                  |

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

| Tool                                      | Mutating | Description                                                                                 |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `gitlab_approve_merge_request`            | **Yes**  | Approve an MR. Supports `sha`, `approval_password`.                                         |
| `gitlab_unapprove_merge_request`          | **Yes**  | Remove current user's approval from an MR.                                                  |
| `gitlab_get_merge_request_approval_state` | No       | Get approval state for an MR, with approvals fallback when `approval_state` is unavailable. |

---

## MR Discussions

| Tool                                          | Mutating | Description                                                                                                                                                        |
| --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gitlab_list_merge_request_discussions`       | No       | List MR discussions.                                                                                                                                               |
| `gitlab_mr_discussions`                       | No       | Alias of `list_merge_request_discussions`.                                                                                                                         |
| `gitlab_create_merge_request_thread`          | **Yes**  | Create a new discussion thread. Params: `body` (required). Supports `position` (for diff comments), `created_at`.                                                  |
| `gitlab_create_merge_request_discussion_note` | **Yes**  | Reply to an existing discussion thread. Params: `discussion_id`, `body` (required).                                                                                |
| `gitlab_update_merge_request_discussion_note` | **Yes**  | Update a discussion note. Provide either `body` or `resolved` (not both).                                                                                          |
| `gitlab_delete_merge_request_discussion_note` | **Yes**  | Delete an MR discussion note permanently. Irreversible. Requires `merge_request_iid`, `discussion_id`, `note_id`. Pre-check with `list_merge_request_discussions`. |
| `gitlab_resolve_merge_request_thread`         | **Yes**  | Resolve/unresolve a discussion note. Params: `discussion_id`, `note_id`, `resolved` (default `true`).                                                              |

---

## MR Notes (Comments)

| Tool                               | Mutating | Description                                                                                                                                                           |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_merge_request_notes`  | No       | List top-level MR notes. Supports `sort`, `order_by`.                                                                                                                 |
| `gitlab_get_merge_request_notes`   | No       | Alias of `list_merge_request_notes`.                                                                                                                                  |
| `gitlab_get_merge_request_note`    | No       | Get a single MR note by ID.                                                                                                                                           |
| `gitlab_create_merge_request_note` | **Yes**  | Create a top-level MR comment. Params: `body` (required).                                                                                                             |
| `gitlab_update_merge_request_note` | **Yes**  | Update MR note body. Params: `note_id`, `body` (required).                                                                                                            |
| `gitlab_delete_merge_request_note` | **Yes**  | Delete a top-level MR note permanently. Irreversible. Requires `merge_request_iid`, `note_id`. Pre-check with `get_merge_request_note` or `list_merge_request_notes`. |
| `gitlab_create_note`               | **Yes**  | Create a note on an issue or MR. Params: `noteable_type` (`issue`/`merge_request`), `noteable_iid`, `body` (required).                                                |

### MR Emoji Reactions

| Tool                                              | Mutating | Description                                                                                                                   |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_merge_request_emoji_reactions`       | No       | List emoji reactions on an MR. Params: `merge_request_iid` (required).                                                        |
| `gitlab_list_merge_request_note_emoji_reactions`  | No       | List emoji reactions on an MR note. Params: `merge_request_iid`, `note_id` (required). Supports `discussion_id`.              |
| `gitlab_create_merge_request_emoji_reaction`      | **Yes**  | Add an emoji reaction to an MR. Params: `merge_request_iid`, `name` (required).                                               |
| `gitlab_delete_merge_request_emoji_reaction`      | **Yes**  | Delete an emoji reaction from an MR. Irreversible for that reaction. Params: `merge_request_iid`, `award_id` (required).      |
| `gitlab_create_merge_request_note_emoji_reaction` | **Yes**  | Add an emoji reaction to an MR note. Params: `merge_request_iid`, `note_id`, `name` (required). Supports `discussion_id`.     |
| `gitlab_delete_merge_request_note_emoji_reaction` | **Yes**  | Delete an emoji reaction from an MR note. Irreversible for that reaction. Params: `merge_request_iid`, `note_id`, `award_id`. |

---

## Draft Notes

| Tool                              | Mutating | Description                                                                                                                                          |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_get_draft_note`           | No       | Get a single draft note.                                                                                                                             |
| `gitlab_list_draft_notes`         | No       | List draft notes on an MR.                                                                                                                           |
| `gitlab_create_draft_note`        | **Yes**  | Create a draft note. Params: `body` (required). Supports `position`, `resolve_discussion`.                                                           |
| `gitlab_update_draft_note`        | **Yes**  | Update a draft note. At least one of `body`, `position`, or `resolve_discussion` required.                                                           |
| `gitlab_delete_draft_note`        | **Yes**  | Delete a draft note permanently. Irreversible. Requires `merge_request_iid`, `draft_note_id`. Pre-check with `get_draft_note` or `list_draft_notes`. |
| `gitlab_publish_draft_note`       | **Yes**  | Publish one draft note.                                                                                                                              |
| `gitlab_bulk_publish_draft_notes` | **Yes**  | Publish all draft notes on an MR.                                                                                                                    |

---

## Issues

| Tool                                    | Mutating | Description                                                                                                                                                                                    |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_issues`                    | No       | List issues. When `project_id` is omitted, lists globally. Supports `assignee_id`, `author_id`, `state`, `labels`, `milestone`, `scope`, `search`, `issue_type`, `confidential`, date filters. |
| `gitlab_my_issues`                      | No       | List issues assigned to the current user. Supports `state`, `labels`, `search`, date filters.                                                                                                  |
| `gitlab_get_issue`                      | No       | Get issue by IID. The milestone is slim by default; set `full_response=true` for its complete description and metadata.                                                                        |
| `gitlab_create_issue`                   | **Yes**  | Create an issue. Params: `title` (required). Supports `description`, `labels`, `milestone_id`, `due_date`, `confidential`, `issue_type`, `assignee_ids`.                                       |
| `gitlab_update_issue`                   | **Yes**  | Update issue fields. Returns a slim confirmation by default; set `full_response=true` for the complete updated issue.                                                                          |
| `gitlab_update_issue_description_patch` | **Yes**  | Apply `search_replace` or `unified_diff` patch to an issue description. Supports `dry_run`, `create_note`, `allow_multiple`.                                                                   |
| `gitlab_delete_issue`                   | **Yes**  | Delete an issue permanently. Irreversible. Requires `issue_iid`. Pre-check with `get_issue`.                                                                                                   |
| `gitlab_list_issue_discussions`         | No       | List issue discussions.                                                                                                                                                                        |
| `gitlab_create_issue_note`              | **Yes**  | Create issue comment. Params: `body` (required). Supports `discussion_id` (to reply to thread), `created_at`.                                                                                  |
| `gitlab_update_issue_note`              | **Yes**  | Update an issue note. Provide either `body` or `resolved` (not both).                                                                                                                          |

### Issue Emoji Reactions

| Tool                                      | Mutating | Description                                                                                                              |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `gitlab_list_issue_emoji_reactions`       | No       | List emoji reactions on an issue. Params: `issue_iid` (required).                                                        |
| `gitlab_list_issue_note_emoji_reactions`  | No       | List emoji reactions on an issue note. Params: `issue_iid`, `note_id` (required). Supports `discussion_id`.              |
| `gitlab_create_issue_emoji_reaction`      | **Yes**  | Add an emoji reaction to an issue. Params: `issue_iid`, `name` (required).                                               |
| `gitlab_delete_issue_emoji_reaction`      | **Yes**  | Delete an emoji reaction from an issue. Irreversible for that reaction. Params: `issue_iid`, `award_id` (required).      |
| `gitlab_create_issue_note_emoji_reaction` | **Yes**  | Add an emoji reaction to an issue note. Params: `issue_iid`, `note_id`, `name` (required). Supports `discussion_id`.     |
| `gitlab_delete_issue_note_emoji_reaction` | **Yes**  | Delete an emoji reaction from an issue note. Irreversible for that reaction. Params: `issue_iid`, `note_id`, `award_id`. |

### Todos

| Tool                         | Mutating | Description                                                                                                                   |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_todos`          | No       | List to-do items for the current user. Supports `action`, `author_id`, `project_id`, `group_id`, `state`, `type`, pagination. |
| `gitlab_mark_todo_done`      | **Yes**  | Mark one to-do item as done. Params: `todo_id` (required).                                                                    |
| `gitlab_mark_all_todos_done` | **Yes**  | Mark all pending to-do items as done for the current authenticated user.                                                      |

### Issue Links

| Tool                       | Mutating | Description                                                                                                                                                       |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_issue_links`  | No       | List related issue links.                                                                                                                                         |
| `gitlab_get_issue_link`    | No       | Get a single issue link by ID.                                                                                                                                    |
| `gitlab_create_issue_link` | **Yes**  | Create a relation between two issues. Params: `target_project_id`, `target_issue_iid` (required). Supports `link_type` (`relates_to`, `blocks`, `is_blocked_by`). |
| `gitlab_delete_issue_link` | **Yes**  | Delete an issue link permanently. Irreversible for that relation. Requires `issue_iid`, `issue_link_id`. Pre-check with `get_issue_link` or `list_issue_links`.   |

---

## Wiki

Requires `USE_GITLAB_WIKI=true` (default).

| Tool                            | Mutating | Description                                                                                                           |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_wiki_pages`        | No       | List wiki pages. Supports `with_content` and `render_html`; rendered responses preserve `front_matter`.               |
| `gitlab_get_wiki_page`          | No       | Get wiki page by slug. Supports `version` and `render_html`; rendered responses preserve `front_matter`.              |
| `gitlab_create_wiki_page`       | **Yes**  | Create a wiki page. Params: `title`, `content` (required). Supports `format` (`markdown`, `rdoc`, `asciidoc`, `org`). |
| `gitlab_update_wiki_page`       | **Yes**  | Update wiki page by slug. Leaf-only title updates preserve the parent path for nested pages.                          |
| `gitlab_delete_wiki_page`       | **Yes**  | Delete a wiki page permanently. Irreversible. Requires `slug`. Pre-check with `get_wiki_page` or `list_wiki_pages`.   |
| `gitlab_list_group_wiki_pages`  | No       | List group wiki pages. Supports `with_content`, `render_html`, and pagination.                                        |
| `gitlab_get_group_wiki_page`    | No       | Get group wiki page by slug. Supports `version` and `render_html`; rendered responses preserve `front_matter`.        |
| `gitlab_create_group_wiki_page` | **Yes**  | Create a group wiki page. Params: `group_id`, `title`, `content` (required). Supports `format`.                       |
| `gitlab_update_group_wiki_page` | **Yes**  | Update a group wiki page. Leaf-only title updates preserve the parent path for nested pages.                          |
| `gitlab_delete_group_wiki_page` | **Yes**  | Delete a group wiki page permanently. Irreversible. Requires `group_id`, `slug`. Pre-check with group wiki get/list.  |

---

## Pipelines & Jobs

Requires `USE_PIPELINE=true` (default).

| Tool                                  | Mutating | Description                                                                                                                                                                                  |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_pipelines`               | No       | List pipelines. Supports `scope`, `status`, `ref`, `sha`, `username`, `source`, `order_by`, `sort`, date filters.                                                                            |
| `gitlab_get_pipeline`                 | No       | Get one pipeline by ID.                                                                                                                                                                      |
| `gitlab_list_deployments`             | No       | List deployments. Supports `environment`, `ref`, `sha`, `status`, `order_by`, `sort`, date filters.                                                                                          |
| `gitlab_get_deployment`               | No       | Get one deployment by ID.                                                                                                                                                                    |
| `gitlab_list_environments`            | No       | List environments. Supports `name`, `search`, `states`, pagination.                                                                                                                          |
| `gitlab_get_environment`              | No       | Get one environment by ID.                                                                                                                                                                   |
| `gitlab_list_pipeline_jobs`           | No       | List jobs in a pipeline. Supports `scope`, `include_retried`.                                                                                                                                |
| `gitlab_list_pipeline_trigger_jobs`   | No       | List downstream/bridge trigger jobs in a pipeline.                                                                                                                                           |
| `gitlab_get_pipeline_job`             | No       | Get one job by ID.                                                                                                                                                                           |
| `gitlab_get_pipeline_job_output`      | No       | Get a byte-bounded, untrusted job trace window (`limit` defaults to/maxes at 1,000 lines; `offset` skips lines from the end).                                                                |
| `gitlab_validate_ci_lint`             | No       | Validate provided GitLab CI/CD YAML content. Supports `dry_run`, `include_jobs`, and `ref`.                                                                                                  |
| `gitlab_validate_project_ci_lint`     | No       | Validate the project's existing CI/CD config. Supports `content_ref`, `dry_run`, `dry_run_ref`, and `include_jobs`.                                                                          |
| `gitlab_list_job_artifacts`           | No       | List files and directories inside a job artifacts archive. Supports `path`, `recursive`.                                                                                                     |
| `gitlab_download_job_artifacts`       | No       | Download the full artifacts archive as base64 content on local transports. HTTP remote mode returns a short-lived `download_url`.                                                            |
| `gitlab_download_job_artifacts_local` | **Yes**  | Download the full artifacts archive under `GITLAB_LOCAL_FILE_ROOTS`. Available only on local transports; not exposed over HTTP.                                                              |
| `gitlab_get_job_artifact_file`        | No       | Return one file from a job artifacts archive as inline content. Text-like files are UTF-8; binary files are base64.                                                                          |
| `gitlab_get_job_artifact_file_local`  | **Yes**  | Save one artifact file under `GITLAB_LOCAL_FILE_ROOTS`. Available only on local transports; not exposed over HTTP.                                                                           |
| `gitlab_create_pipeline`              | **Yes**  | Trigger a new pipeline. Params: `ref` (required). Supports `variables` array (`key`, `value`, `variable_type`) and typed `inputs` for `spec:inputs` (`string`, `number`, `boolean`, arrays). |
| `gitlab_retry_pipeline`               | **Yes**  | Retry failed jobs in a pipeline.                                                                                                                                                             |
| `gitlab_cancel_pipeline`              | **Yes**  | Cancel a running pipeline.                                                                                                                                                                   |
| `gitlab_retry_pipeline_job`           | **Yes**  | Retry one failed job.                                                                                                                                                                        |
| `gitlab_cancel_pipeline_job`          | **Yes**  | Cancel one running job.                                                                                                                                                                      |
| `gitlab_play_pipeline_job`            | **Yes**  | Play/trigger a manual job.                                                                                                                                                                   |

---

## Milestones

Requires `USE_MILESTONE=true` (default).

| Tool                                   | Mutating | Description                                                                                                                 |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_milestones`               | No       | List project milestones. Supports `iids`, `state`, `title`, `search`, `include_ancestors`, date filters.                    |
| `gitlab_get_milestone`                 | No       | Get a milestone by ID.                                                                                                      |
| `gitlab_create_milestone`              | **Yes**  | Create a milestone. Params: `title` (required). Supports `description`, `due_date`, `start_date`.                           |
| `gitlab_update_milestone`              | **Yes**  | Update milestone fields.                                                                                                    |
| `gitlab_edit_milestone`                | **Yes**  | Alias of `update_milestone`.                                                                                                |
| `gitlab_delete_milestone`              | **Yes**  | Delete a milestone permanently. Irreversible. Requires `milestone_id`. Pre-check with `get_milestone` or `list_milestones`. |
| `gitlab_get_milestone_issue`           | No       | List issues assigned to a milestone.                                                                                        |
| `gitlab_get_milestone_merge_requests`  | No       | List MRs assigned to a milestone.                                                                                           |
| `gitlab_promote_milestone`             | **Yes**  | Promote a project milestone to a group milestone.                                                                           |
| `gitlab_get_milestone_burndown_events` | No       | List burndown events for a milestone.                                                                                       |

---

## Releases

Requires `USE_RELEASE=true` (default).

| Tool                             | Mutating | Description                                                                                                                                   |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_releases`           | No       | List project releases. Supports `order_by`, `sort`, `include_html_description`.                                                               |
| `gitlab_get_release`             | No       | Get one release by tag name.                                                                                                                  |
| `gitlab_create_release`          | **Yes**  | Create a release. Params: `tag_name` (required). Supports `name`, `tag_message`, `description`, `ref`, `released_at`, `milestones`, `assets`. |
| `gitlab_update_release`          | **Yes**  | Update existing release.                                                                                                                      |
| `gitlab_delete_release`          | **Yes**  | Delete the release entry for `tag_name` permanently. Irreversible for the release record. Pre-check with `get_release` or `list_releases`.    |
| `gitlab_create_release_evidence` | **Yes**  | Create evidence for an existing release.                                                                                                      |
| `gitlab_download_release_asset`  | No       | Download a release asset. Params: `tag_name`, `direct_asset_path` (required). HTTP remote mode returns a short-lived `download_url`.          |

---

## Tags

| Tool                       | Mutating | Description                                                                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `gitlab_list_tags`         | No       | List repository tags. Supports `order_by`, `sort`, `search`, and pagination.                                     |
| `gitlab_get_tag`           | No       | Get one repository tag by name. Params: `tag_name` (required).                                                   |
| `gitlab_create_tag`        | **Yes**  | Create a repository tag. Params: `tag_name`, `ref` (required). Supports optional `message` for annotated tags.   |
| `gitlab_delete_tag`        | **Yes**  | Delete a repository tag permanently. Irreversible. Requires `tag_name`. Pre-check with `get_tag` or `list_tags`. |
| `gitlab_get_tag_signature` | No       | Get the X.509 signature for a signed repository tag. Params: `tag_name` (required).                              |

---

## Labels

| Tool                  | Mutating | Description                                                                                                              |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `gitlab_list_labels`  | No       | List project labels. Supports `with_counts`, `include_ancestor_groups`, `search`.                                        |
| `gitlab_get_label`    | No       | Get one label by ID. Supports `include_ancestor_groups`.                                                                 |
| `gitlab_create_label` | **Yes**  | Create a label. Params: `name`, `color` (required). Supports `description`, `priority`.                                  |
| `gitlab_update_label` | **Yes**  | Update a label. Identify by `name` or `label_id`. Supports `new_name`, `color`, `description`, `priority`.               |
| `gitlab_delete_label` | **Yes**  | Delete a label permanently. Irreversible. Identify by `name` or `label_id`. Pre-check with `get_label` or `list_labels`. |

---

## Uploads & Attachments

| Tool                         | Mutating | Description                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_upload_markdown`     | **Yes**  | Upload markdown content or a stdio-local file under `GITLAB_LOCAL_FILE_ROOTS`; HTTP mode rejects `file_path` and requires inline content.                                                                                                                                                                                                                                                                                          |
| `gitlab_download_attachment` | No       | Download attachment. Provide either `url_or_path` or both `secret` and `filename`. Absolute `url_or_path` must be same-origin with configured GitLab API URL. In project-scoped mode (`GITLAB_ALLOWED_PROJECT_IDS`), `url_or_path` must be a GitLab upload URL/path and `project_id` must be provided (or inferred from a single allowed project). HTTP remote mode returns a short-lived `download_url` for project upload paths. |

---

## Work Items

These tools use GitLab GraphQL but remain available when `GITLAB_ALLOWED_PROJECT_IDS` is configured because they are project-bound. Their source, target, and parent project arguments must all be allowed.

| Tool                                          | Mutating | Description                                                                                                                                                |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitlab_get_work_item`                        | No       | Get a work item with status, hierarchy, labels, assignees, linked items, custom fields, timeline-related widgets, and development data.                    |
| `gitlab_list_work_items`                      | No       | List work items in a project. Supports `types`, `state`, `search`, `assignee_usernames`, `label_names`, `first`, and cursor `after`.                       |
| `gitlab_create_work_item`                     | **Yes**  | Create a work item. Supports all GitLab work item types plus description, labels, assignees, parent, weight, dates, milestone, iteration, confidentiality. |
| `gitlab_update_work_item`                     | **Yes**  | Update fields, labels, assignees, state, status, hierarchy, linked items, custom fields, dates, milestone, iteration, and incident severity/escalation.    |
| `gitlab_convert_work_item_type`               | **Yes**  | Convert a work item to another type. Params: `iid`, `new_type` (required).                                                                                 |
| `gitlab_list_work_item_statuses`              | No       | List statuses, conversion types, and allowed hierarchy types for a work item type.                                                                         |
| `gitlab_list_custom_field_definitions`        | No       | List custom field IDs, types, select options, and supported work item types.                                                                               |
| `gitlab_move_work_item`                       | **Yes**  | Move a work item to another project. Params: `iid`, `target_project_id` (required).                                                                        |
| `gitlab_list_work_item_notes`                 | No       | List threaded work item discussions and notes with pagination.                                                                                             |
| `gitlab_create_work_item_note`                | **Yes**  | Add a work item note or threaded reply. Supports `internal` and `discussion_id`.                                                                           |
| `gitlab_list_work_item_emoji_reactions`       | No       | List emoji reactions on a work item.                                                                                                                       |
| `gitlab_list_work_item_note_emoji_reactions`  | No       | List emoji reactions on a work item note by GraphQL `note_id`.                                                                                             |
| `gitlab_create_work_item_emoji_reaction`      | **Yes**  | Add an emoji reaction to a work item. Params: `iid`, `name` (required).                                                                                    |
| `gitlab_delete_work_item_emoji_reaction`      | **Yes**  | Remove the current user's emoji reaction from a work item by emoji name.                                                                                   |
| `gitlab_create_work_item_note_emoji_reaction` | **Yes**  | Add an emoji reaction to a work item note by GraphQL `note_id`.                                                                                            |
| `gitlab_delete_work_item_note_emoji_reaction` | **Yes**  | Remove the current user's emoji reaction from a work item note by GraphQL `note_id` and emoji name.                                                        |
| `gitlab_get_timeline_events`                  | No       | List incident timeline events. Params: `incident_iid` (required).                                                                                          |
| `gitlab_create_timeline_event`                | **Yes**  | Create an incident timeline event. Params: `incident_iid`, `note`, `occurred_at` (required), optional `tag_names`.                                         |

---

## GraphQL

| Tool                              | Mutating | Description                                                                                  |
| --------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `gitlab_execute_graphql_query`    | No       | Execute a read-only GraphQL query. Rejects mutations.                                        |
| `gitlab_execute_graphql_mutation` | **Yes**  | Execute a GraphQL mutation. Disabled in read-only mode.                                      |
| `gitlab_execute_graphql`          | No\*     | Backward-compatible executor. Automatically detects mutations and enforces read-only policy. |

\* `gitlab_execute_graphql` is registered with read + graphql capability and dynamically requires write + graphql capability when the payload contains a mutation.

When `GITLAB_ALLOWED_PROJECT_IDS` is configured, all raw GraphQL tools are hidden because arbitrary GraphQL documents cannot be proven project-safe. The legacy `GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE` setting is retained for compatibility but does not override this restriction. Use the project-bound Work Item tools above for supported GraphQL operations.
