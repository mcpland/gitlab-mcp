import { GitLabClient } from "../src/lib/gitlab-client.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function enabled(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an unexpected response shape`);
  }
  return value as Record<string, unknown>;
}

function assertGraphqlSucceeded(value: unknown, label: string): Record<string, unknown> {
  const response = record(value, label);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    const messages = response.errors.map((error) => {
      if (error && typeof error === "object" && "message" in error) {
        return String((error as { message?: unknown }).message ?? "GraphQL error");
      }
      return "GraphQL error";
    });
    throw new Error(`${label} failed: ${messages.join("; ")}`);
  }
  return record(response.data, `${label}.data`);
}

async function main(): Promise<void> {
  const apiUrl = requiredEnv("GITLAB_API_URL");
  const token = requiredEnv("GITLAB_PERSONAL_ACCESS_TOKEN");
  const projectId = requiredEnv("GITLAB_LIVE_TEST_PROJECT_ID");
  const client = new GitLabClient(apiUrl, token, {
    timeoutMs: 30_000,
    maxGetRetries: 1
  });

  const user = record(await client.whoami(), "GET /user");
  if (typeof user.id !== "number" && typeof user.id !== "string") {
    throw new Error("GET /user did not return a user ID");
  }

  const project = record(await client.getProject(projectId), "GET /projects/:id");
  const projectPath = project.path_with_namespace;
  if (typeof projectPath !== "string" || !projectPath) {
    throw new Error("Project response did not include path_with_namespace");
  }

  await Promise.all([
    client.listBranches(projectId, { query: { per_page: 1 } }),
    client.listMergeRequests(projectId, { query: { state: "all", per_page: 1 } }),
    client.listIssues(projectId, { query: { state: "all", per_page: 1 } }),
    client.listPipelines(projectId, { query: { per_page: 1 } })
  ]);

  const projectGraphql = assertGraphqlSucceeded(
    await client.executeGraphql(
      "query LiveProject($fullPath: ID!) { project(fullPath: $fullPath) { id fullPath } }",
      { fullPath: projectPath }
    ),
    "project GraphQL smoke"
  );
  if (!projectGraphql.project) {
    throw new Error("Project GraphQL smoke did not return the target project");
  }

  if (enabled("GITLAB_LIVE_TEST_CI_CATALOG")) {
    assertGraphqlSucceeded(
      await client.executeGraphql(
        "query LiveCatalog { ciCatalogResources(first: 1) { nodes { id fullPath } pageInfo { hasNextPage endCursor } } }"
      ),
      "CI/CD Catalog GraphQL smoke"
    );
  }

  if (enabled("GITLAB_LIVE_TEST_DEPENDENCY_PROXY")) {
    const groupId = requiredEnv("GITLAB_LIVE_TEST_GROUP_ID");
    const group = record(await client.getGroup(groupId), "GET /groups/:id");
    const groupPath = group.full_path;
    if (typeof groupPath !== "string" || !groupPath) {
      throw new Error("Group response did not include full_path");
    }
    const data = assertGraphqlSucceeded(
      await client.executeGraphql(
        `query LiveDependencyProxy($fullPath: ID!) {
          group(fullPath: $fullPath) {
            dependencyProxySetting { enabled identity }
            dependencyProxyBlobCount
            dependencyProxyImageCount
            dependencyProxyTotalSizeBytes
          }
        }`,
        { fullPath: groupPath }
      ),
      "Dependency Proxy GraphQL smoke"
    );
    if (!data.group) {
      throw new Error("Dependency Proxy GraphQL smoke did not return the target group");
    }
  }

  process.stdout.write("Live GitLab read-only smoke checks passed.\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown live smoke failure";
  process.stderr.write(`Live GitLab smoke failed: ${message}\n`);
  process.exitCode = 1;
});
