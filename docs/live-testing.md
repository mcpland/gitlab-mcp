# Live GitLab Smoke Testing

The normal test suite is deterministic and uses mocked GitLab responses. A separate, manually triggered workflow verifies a small read-only path against a real GitLab instance without exposing repository secrets to pull requests.

## GitHub Actions setup

Configure these repository secrets:

| Secret                   | Purpose                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `GITLAB_LIVE_API_URL`    | GitLab REST API v4 URL, such as `https://gitlab.com/api/v4`.     |
| `GITLAB_LIVE_TOKEN`      | A dedicated, least-privilege token for the smoke project.        |
| `GITLAB_LIVE_PROJECT_ID` | Numeric ID, raw path, or URL-encoded path of a readable project. |

Run **Live GitLab Smoke** from the Actions tab. The baseline checks only read the current user, project, branches, merge requests, issues, pipelines, and a minimal project GraphQL query.

Two inputs enable version- or license-sensitive checks:

- `test_ci_catalog` validates the CI/CD Catalog GraphQL connection.
- `test_dependency_proxy` validates read-only Dependency Proxy fields and requires `group_id`.

The workflow is `workflow_dispatch` only. It is intentionally not run for pull requests or automatic fork events, so GitLab credentials are never injected into untrusted code.

## Local run

```bash
GITLAB_API_URL=https://gitlab.example.com/api/v4 \
GITLAB_PERSONAL_ACCESS_TOKEN=... \
GITLAB_LIVE_TEST_PROJECT_ID=group/project \
pnpm test:live
```

Optional checks use `GITLAB_LIVE_TEST_CI_CATALOG=true` and `GITLAB_LIVE_TEST_DEPENDENCY_PROXY=true`; the latter also requires `GITLAB_LIVE_TEST_GROUP_ID`.
