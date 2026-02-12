# gitlab-mcp

面向生产的 GitLab MCP 工程化模板（TypeScript + MCP SDK v1 + CI + Docker）。

## 为什么是这个模板

- 对齐官方稳定线：`@modelcontextprotocol/sdk@1.x`（当前仓库 `main` 的 v2 仍是 pre-alpha）。
- 同时支持 `stdio`（本地客户端）和 `Streamable HTTP`（远程部署）。
- 默认包含严格 TypeScript、ESLint、Vitest、GitHub Actions CI、Docker。
- 内置 GitLab 工具：
  - `health_check`
  - `gitlab_get_project`
  - `gitlab_search_projects`

> 协议版本参考：MCP current revision `2025-11-25`。

## 快速开始

```bash
cp .env.example .env
npm install
npm run dev
```

`npm run dev` 启动 `stdio` 模式（适合 Claude Desktop/Cursor 等本地集成）。

## HTTP 模式

```bash
npm run dev:http
```

默认地址：`http://127.0.0.1:3333`

- MCP endpoint: `POST/GET/DELETE /mcp`
- Health endpoint: `GET /healthz`

## Inspector 调试

```bash
npm run build
npm run inspector
```

## 环境变量

见 `.env.example`：

- `GITLAB_BASE_URL`：GitLab 地址（SaaS 或自建）
- `GITLAB_TOKEN`：建议使用具有最小权限的 PAT
- `HTTP_HOST` / `HTTP_PORT`：HTTP 服务监听地址
- `HTTP_JSON_ONLY`：`true` 时返回 JSON，不启用 SSE 流

## 工程命令

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

默认启动 HTTP 服务：`node dist/http.js`。

## 客户端接入（stdio 示例）

先构建：

```bash
npm run build
```

然后在 MCP 客户端配置命令：

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/absolute/path/to/gitlab-mcp/dist/index.js"],
      "env": {
        "GITLAB_BASE_URL": "https://gitlab.com",
        "GITLAB_TOKEN": "<your-token>"
      }
    }
  }
}
```

## 扩展建议

- 在 `src/tools/` 继续按模块增加 GitLab 能力（MR、Issue、Pipeline、Wiki）。
- 将 `GitLabClient` 的 API 能力拆成子模块并加契约测试。
- 若走多节点部署，补充共享 `eventStore` 与会话粘性策略。
