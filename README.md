# GitLab MCP Server

Model Context Protocol (MCP) server for GitLab integration. This server allows communication between GitLab and MCP-compatible AI assistants.

## Features

- Connect to GitLab instances (self-hosted or GitLab.com)
- Provide GitLab data to AI assistants
- Support for projects, merge requests, and repositories
- MCP-compatible API for AI integration

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Build the project:
   ```bash
   npm run build
   ```

3. Configure environment variables:
   - `GITLAB_TOKEN`: Your GitLab API token
   - `GITLAB_URL`: Your GitLab instance URL (defaults to https://gitlab.com)

4. Run the server:
   ```bash
   npm start
   ```

## Development

- Run in watch mode:
  ```bash
  npm run dev
  ```

## License

MIT