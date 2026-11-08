import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getGitLabToolDefinitions } from "../src/tools/gitlab.js";

const toolsReference = readFileSync(new URL("../docs/tools.md", import.meta.url), "utf8");

function documentedToolNames(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`(gitlab_[a-z0-9_]+|health_check)`\s*\|/u.exec(line);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

describe("docs/tools.md", () => {
  const documented = documentedToolNames(toolsReference);
  const registered = new Set(getGitLabToolDefinitions().map((definition) => definition.name));

  it("documents every registered GitLab tool", () => {
    const missing = [...registered].filter((name) => !documented.has(name)).sort();

    expect(missing).toEqual([]);
  });

  it("does not document tools that are no longer registered", () => {
    const stale = [...documented]
      .filter((name) => name !== "health_check" && !registered.has(name))
      .sort();

    expect(stale).toEqual([]);
  });

  it("documents the health check tool", () => {
    expect(documented.has("health_check")).toBe(true);
  });
});
