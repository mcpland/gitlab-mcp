# GitLab MCP Server

Model Context Protocol (MCP) server for GitLab integration. This server allows communication between GitLab and MCP-compatible AI assistants.

## Environment Variables

Before running the server, you need to set the following environment variables:

- `GITLAB_PERSONAL_ACCESS_TOKEN`: Your GitLab personal access token. **Required.**
- `GITLAB_API_URL`: Your GitLab API URL. (Default: `https://gitlab.com/api/v4`)
- `GITLAB_READ_ONLY_MODE`: When set to 'true', restricts the server to only expose read-only operations. Useful for enhanced security or when write access is not needed. Also useful for using with Cursor and its 40 tool limit. (Optional, Default: `false`)

```bash
GITLAB_PERSONAL_ACCESS_TOKEN=your_gitlab_token
GITLAB_API_URL=your_gitlab_api_url  # Default: https://gitlab.com/api/v4
GITLAB_READ_ONLY_MODE=true          # Optional: Enable read-only mode
```

## Usage

### Using with Claude App, Cline, Roo Code, Cursor

When using with the Claude App, you need to set up your API key and URLs directly.

Below is an example configuration:

```json
{
  "mcpServers": {
    "GitLab communication server": {
      "command": "npx",
      "args": ["-y", "mcp-gitlab"],
      "env": {
        "GITLAB_PERSONAL_ACCESS_TOKEN": "your_gitlab_token",
        "GITLAB_API_URL": "your_gitlab_api_url",
        "GITLAB_READ_ONLY_MODE": "true"
      }
    }
  }
}
```

## Tools 🛠️

The server exposes the following tools:

| Tool Name & Emoji             | Description                                                        | Inputs                                                                                                                                                                                                                                                                                          | Returns                             |
| ----------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **`create_or_update_file`** 📝 | Create or update a single file in a GitLab project.                | - `project_id` (string): Project ID or namespace/project_path <br> - `file_path` (string): Path to create/update the file <br> - `content` (string): File content <br> - `commit_message` (string): Commit message <br> - `branch` (string): Branch to create/update the file in <br> - `previous_path` (optional string): Previous file path when renaming a file | File content and commit details     |
| **`push_files`** 📤            | Push multiple files in a single commit.                            | - `project_id` (string): Project ID or namespace/project_path <br> - `branch` (string): Branch to push to <br> - `files` (array): Array of files to push, each with `file_path` and `content` properties <br> - `commit_message` (string): Commit message                                       | Updated branch reference            |
| **`search_repositories`** 🔍   | Search for GitLab projects.                                        | - `search` (string): Search query <br> - `page` (optional number): Page number (default: 1) <br> - `per_page` (optional number): Results per page (default: 20, max: 100)                                                                                                              | Project search results              |
| **`create_repository`** ➕     | Create a new GitLab project.                                       | - `name` (string): Project name <br> - `description` (optional string): Project description <br> - `visibility` (optional string): Project visibility level (public, private, internal) <br> - `initialize_with_readme` (optional boolean): Initialize with README                                 | Details of the created project      |
| **`get_file_contents`** 📂     | Get the contents of a file or directory.                           | - `project_id` (string): Project ID or namespace/project_path <br> - `file_path` (string): Path to the file/directory <br> - `ref` (optional string): Branch, tag, or commit SHA (default: default branch)                                                                                 | File/directory content              |
| **`create_issue`** 🐛          | Create a new issue.                                                | - `project_id` (string): Project ID or namespace/project_path <br> - `title` (string): Issue title <br> - `description` (string): Issue description <br> - `assignee_ids` (optional number[]): Array of assignee IDs <br> - `milestone_id` (optional number): Milestone ID <br> - `labels` (optional string[]): Array of labels | Details of the created issue        |
| **`create_merge_request`** 🚀  | Create a new merge request.                                        | - `project_id` (string): Project ID or namespace/project_path <br> - `title` (string): Merge request title <br> - `description` (string): Merge request description <br> - `source_branch` (string): Branch with changes <br> - `target_branch` (string): Branch to merge into <br> - `allow_collaboration` (optional boolean): Allow collaborators to push commits to the source branch <br> - `draft` (optional boolean): Create as a draft merge request | Details of the created merge request |
| **`fork_repository`** 🍴       | Fork a project.                                                    | - `project_id` (string): Project ID or namespace/project_path to fork <br> - `namespace` (optional string): Namespace to fork into (default: user namespace)                                                                                                                                    | Details of the forked project       |
| **`create_branch`** 🌿         | Create a new branch.                                               | - `project_id` (string): Project ID or namespace/project_path <br> - `name` (string): New branch name <br> - `ref` (optional string): Ref to create the branch from (branch, tag, commit SHA, default: default branch)                                                                          | Created branch reference            |
| **`get_merge_request`** ℹ️    | Get details of a merge request.                                    | - `project_id` (string): Project ID or namespace/project_path <br> - `merge_request_iid` (number): Merge request IID                                                                                                                                                                     | Merge request details               |
| **`get_merge_request_diffs`** diff | Get changes (diffs) of a merge request.                          | - `project_id` (string): Project ID or namespace/project_path <br> - `merge_request_iid` (number): Merge request IID <br> - `view` (optional string): Diff view type ('inline' or 'parallel')                                                                                             | Array of merge request diff information |
| **`update_merge_request`** 🔄  | Update a merge request.                                            | - `project_id` (string): Project ID or namespace/project_path <br> - `merge_request_iid` (number): Merge request IID <br> - `title` (optional string): New title <br> - `description` (string): New description <br> - `target_branch` (optional string): New target branch <br> - `state_event` (optional string): Merge request state change event ('close', 'reopen') <br> - `remove_source_branch` (optional boolean): Remove source branch after merge <br> - `allow_collaboration` (optional boolean): Allow collaborators to push commits to the source branch | Updated merge request details     |
| **`create_note`** 💬           | Create a new note (comment) to an issue or merge request.          | - `project_id` (string): Project ID or namespace/project_path <br> - `noteable_type` (string): Type of noteable ("issue" or "merge_request") <br> - `noteable_iid` (number): IID of the issue or merge request <br> - `body` (string): Note content                                             | Details of the created note         |
| **`list_projects`** 📊         | List accessible projects with rich filtering options.              | - Search/filtering: `search`, `owned`, `membership`, `archived`, `visibility` <br> - Features filtering: `with_issues_enabled`, `with_merge_requests_enabled` <br> - Sorting: `order_by`, `sort` <br> - Access control: `min_access_level` <br> - Pagination: `page`, `per_page`, `simple` | Array of projects                   |
| **`list_labels`** 🏷️          | List all labels for a project with filtering options.              | - `project_id` (string): Project ID or path <br> - `with_counts` (optional): Include issue and merge request counts <br> - `include_ancestor_groups` (optional): Include ancestor groups <br> - `search` (optional): Filter labels by keyword                                            | Array of labels                     |
| **`get_label`**                | Get a single label from a project.                                 | - `project_id` (string): Project ID or path <br> - `label_id` (number/string): Label ID or name <br> - `include_ancestor_groups` (optional): Include ancestor groups                                                                                                                         | label details                       |
| **`create_label`** 🏷️➕       | Create a new label in an object.                                   | - `project_id` (string): Project ID or path <br> - `name` (string): Label name <br> - `color` (string): Color in hex format (e.g., "#FF0000") <br> - `description` (optional): Label description <br> - `priority` (optional): Label priority                                               | Created label details               |
| **`update_label`** 🏷️✏️       | Update an existing label in a project.                             | - `project_id` (string): Project ID or path <br> - `label_id` (number/string): Label ID or name <br> - `new_name` (optional): New label name <br> - `color` (optional): New color in hex format <br> - `description` (optional): New description <br> - `priority` (optional): New priority | Updated label details               |
| **`delete_label`** 🏷️❌       | Delete a label from a project.                                     | - `project_id` (string): Project ID or path <br> - `label_id` (number/string): Label ID or name                                                                                                                                                                                          | Success message                     |
| **`list_group_projects`** 📂   | List all projects in a GitLab group.                               | - `group_id` (string): Project ID or namespace/project_path <br> - Filtering options: `include_subgroups`, `search`, `archived`, `visibility`, `with_programming_language`, `starred` <br> - Feature filtering: `with_issues_enabled`, `with_merge_requests_enabled`, `min_access_level` <br> - Pagination: `page`, `per_page` <br> - Sorting: `order_by`, `sort` <br> - Additional data: `statistics`, `with_custom_attributes`, `with_security_reports` | List of projects                    |

## Credits

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [GitLab MCP](https://github.com/zereight/gitlab-mcp)

## License

MIT
