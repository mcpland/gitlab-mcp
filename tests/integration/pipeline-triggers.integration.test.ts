/**
 * Pipeline trigger token tools: token values stay out of reads and errors.
 */
import { describe, expect, it, vi } from "vitest";

import { attachPaginationMetadata } from "../../src/lib/pagination.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

const TOKEN = "glptt-0123456789abcdef";

describe("pipeline trigger tools", () => {
  it("never returns trigger token values from list, get, or update", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(
        attachPaginationMetadata([{ id: 1, description: "deploy", token: TOKEN }], {
          page: 1,
          per_page: 20,
          next_page: 2
        })
      )
      .mockResolvedValueOnce({ id: 1, description: "deploy", token: TOKEN });
    const put = vi.fn().mockResolvedValue({ id: 1, description: "renamed", token: TOKEN });
    const context = buildContext({ gitlabStub: { get, put } });

    const listed = await callToolWithContext(context, "gitlab_list_pipeline_triggers", {
      project_id: "group/project"
    });
    const fetched = await callToolWithContext(context, "gitlab_get_pipeline_trigger", {
      project_id: "group/project",
      trigger_id: 1
    });
    const updated = await callToolWithContext(context, "gitlab_update_pipeline_trigger", {
      project_id: "group/project",
      trigger_id: "1",
      description: "renamed"
    });

    for (const result of [listed, fetched, updated]) {
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
    expect(parseToolText(listed)).toEqual([{ id: 1, description: "deploy" }]);
    expect(
      (listed.structuredContent as { meta?: { pagination?: unknown } }).meta?.pagination
    ).toMatchObject({ next_page: 2 });
    expect(get).toHaveBeenNthCalledWith(2, "/projects/group%2Fproject/triggers/1");
    expect(put).toHaveBeenCalledWith("/projects/group%2Fproject/triggers/1", {
      body: JSON.stringify({ description: "renamed" }),
      headers: { "Content-Type": "application/json" }
    });
  });

  it("returns the new token once on create and deletes by id", async () => {
    const post = vi.fn().mockResolvedValue({ id: 2, description: "ci", token: TOKEN });
    const del = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { post, delete: del } });

    const created = parseToolText(
      await callToolWithContext(context, "gitlab_create_pipeline_trigger", {
        project_id: "group/project",
        description: "ci"
      })
    );
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_pipeline_trigger", {
        project_id: "group/project",
        trigger_id: "2"
      })
    );

    expect(created).toMatchObject({ token: TOKEN });
    expect(del).toHaveBeenCalledWith("/projects/group%2Fproject/triggers/2");
    expect(deleted).toEqual({ status: "deleted", project_id: "group/project", trigger_id: "2" });
  });

  it("sends the trigger token in the body and never echoes it in errors", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ id: 99, status: "created" })
      .mockRejectedValueOnce(new Error(`token ${TOKEN} is invalid`));
    const context = buildContext({ gitlabStub: { post } });

    const ok = await callToolWithContext(context, "gitlab_trigger_pipeline", {
      project_id: "group/project",
      token: TOKEN,
      ref: "main",
      variables: { DEPLOY: "true" },
      inputs: { replicas: 2 }
    });
    const failed = await callToolWithContext(context, "gitlab_trigger_pipeline", {
      project_id: "group/project",
      token: TOKEN,
      ref: "main"
    });

    expect(ok.isError).toBeFalsy();
    const [path, options] = post.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/projects/group%2Fproject/trigger/pipeline");
    expect(path).not.toContain(TOKEN);
    expect(JSON.parse(options.body)).toEqual({
      token: TOKEN,
      ref: "main",
      variables: { DEPLOY: "true" },
      inputs: { replicas: 2 }
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).not.toContain(TOKEN);
  });
});
