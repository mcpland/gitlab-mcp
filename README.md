# gitlab-mcp

面向生产的 GitLab MCP 服务器（TypeScript + MCP SDK v1），综合参考 `other/` 与 `plan.md`，实现了：

- 大规模 GitLab 工具集（项目、仓库、MR、Issue、Pipeline、Release、Wiki、GraphQL）
- 策略层（readonly、allowlist、deny regex、feature toggle）
- Streamable HTTP 会话治理（每会话串行队列、TTL 回收、容量上限、限流、remote auth）
- 输出控制（`json` / `compact-json` / `yaml` + 大响应截断）
- 高阶代码审查工具：`gitlab_get_merge_request_code_context`

## 核心能力

### 1) Tool Policy（对应 plan 的 P0）

- `GITLAB_READ_ONLY_MODE=true` 时，所有 mutating 工具自动禁用
- `GITLAB_ALLOWED_TOOLS` 支持显式白名单
- `GITLAB_DENIED_TOOLS_REGEX` 支持统一 deny 规则
- GraphQL 按 query/mutation 拆分：
  - `gitlab_execute_graphql_query`
  - `gitlab_execute_graphql_mutation`（readonly 下禁用）

### 2) 会话与并发（对应 plan 的 P1）

- 同一 session 的请求进入串行队列，避免并发卡死
- 空闲 session 自动回收（`SESSION_TIMEOUT_SECONDS`）
- `MAX_SESSIONS` 容量保护
- `MAX_REQUESTS_PER_MINUTE` 每 session 限流

### 3) MR Code Context（plan 重点特性）

`gitlab_get_merge_request_code_context` 支持：

- `include_paths` / `exclude_paths`
- `extensions` / `languages`
- `mode = patch | surrounding | fullfile`
- `max_files` + `max_total_chars`（预算截断）
- `sort = changed_lines | path | file_size`
- `list_only` 二段式拉取

## 快速开始

```bash
cp .env.example .env
npm install
npm run dev
```

`npm run dev` 为 `stdio` 模式。

### HTTP 模式

```bash
npm run dev:http
```

- MCP endpoint: `POST/GET/DELETE /mcp`
- Health endpoint: `GET /healthz`

## Remote Authorization（HTTP）

当 `REMOTE_AUTHORIZATION=true` 时，token 由请求头按 session 注入：

- `Authorization: Bearer <token>` 或 `Private-Token: <token>`
- 若 `ENABLE_DYNAMIC_API_URL=true`，可额外提供：
  - `x-gitlab-api-url: https://your.gitlab.example.com/api/v4`

说明：

- tools/list 不依赖 token，可先发现工具
- tool call 时才校验会话是否具备有效 auth

## 工具目录（主要）

- 项目与组织
  - `gitlab_get_project`
  - `gitlab_list_projects`
  - `gitlab_list_project_members`
  - `gitlab_list_group_projects`
  - `gitlab_list_namespaces`
  - `gitlab_get_namespace`
- 仓库与文件
  - `gitlab_get_repository_tree`
  - `gitlab_get_file_contents`
  - `gitlab_create_or_update_file`
  - `gitlab_push_files`
  - `gitlab_create_branch`
  - `gitlab_get_branch_diffs`
- Merge Request
  - `gitlab_list_merge_requests`
  - `gitlab_get_merge_request`
  - `gitlab_get_merge_request_diffs`
  - `gitlab_list_merge_request_versions`
  - `gitlab_get_merge_request_version`
  - `gitlab_get_merge_request_code_context`
  - `gitlab_merge_merge_request`
  - `gitlab_approve_merge_request`
- MR 评论与讨论
  - `gitlab_list_merge_request_discussions`
  - `gitlab_create_merge_request_discussion_note`
  - `gitlab_update_merge_request_discussion_note`
  - `gitlab_delete_merge_request_discussion_note`
  - `gitlab_resolve_merge_request_thread`
  - `gitlab_list_merge_request_notes`
- Issues
  - `gitlab_list_issues`
  - `gitlab_get_issue`
  - `gitlab_create_issue`
  - `gitlab_update_issue`
  - `gitlab_create_issue_note`
- Pipelines（可由 `USE_PIPELINE` 开关控制）
  - `gitlab_list_pipelines`
  - `gitlab_get_pipeline`
  - `gitlab_list_pipeline_jobs`
  - `gitlab_get_pipeline_job_output`
  - `gitlab_create_pipeline`
  - `gitlab_retry_pipeline`
  - `gitlab_cancel_pipeline`
- Releases / Wiki / Milestones
  - `gitlab_list_releases`, `gitlab_create_release` 等
  - `gitlab_list_wiki_pages`, `gitlab_create_wiki_page` 等
  - `gitlab_list_milestones`, `gitlab_create_milestone` 等
- GraphQL / 附件
  - `gitlab_execute_graphql_query`
  - `gitlab_execute_graphql_mutation`
  - `gitlab_upload_markdown`
  - `gitlab_download_attachment`

## 质量与构建

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Docker

```bash
docker compose up -d --build
```

默认入口：`node dist/http.js`。
