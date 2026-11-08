/**
 * MCP workflow prompts.
 */
import { describe, expect, it } from "vitest";

import { GITLAB_PROMPTS } from "../../src/server/prompts.js";
import { getGitLabToolDefinitions } from "../../src/tools/gitlab.js";
import { buildContext, createLinkedPair } from "./_helpers.js";

describe("GitLab prompts", () => {
  it("are listed with their arguments", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(buildContext());
    try {
      const { prompts } = await client.listPrompts();

      expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
        "review_merge_request",
        "triage_pipeline_failure",
        "triage_vulnerabilities"
      ]);
      expect(prompts.find((prompt) => prompt.name === "review_merge_request")?.arguments).toEqual([
        expect.objectContaining({ name: "project_id", required: true }),
        expect.objectContaining({ name: "merge_request_iid", required: true })
      ]);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("render the workflow with the supplied arguments", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(buildContext());
    try {
      const result = await client.getPrompt({
        name: "triage_pipeline_failure",
        arguments: { project_id: "group/project", pipeline_id: "4242" }
      });
      const text = (result.messages[0]?.content as { text: string }).text;

      expect(result.messages[0]?.role).toBe("user");
      expect(text).toContain("pipeline 4242 in project group/project");
      expect(text).toContain("gitlab_get_pipeline_test_report");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("only reference registered tools", () => {
    const registered = new Set(getGitLabToolDefinitions().map((definition) => definition.name));
    for (const prompt of GITLAB_PROMPTS) {
      const text = prompt.render(
        Object.fromEntries(Object.keys(prompt.args).map((name) => [name, "x"]))
      );
      for (const name of text.match(/gitlab_[a-z_]+/gu) ?? []) {
        expect(registered.has(name), `${prompt.name}: ${name}`).toBe(true);
      }
    }
  });
});
