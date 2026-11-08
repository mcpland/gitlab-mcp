/**
 * Pipeline schedule tools: request paths, payloads, and secret handling.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, callToolWithContext, createLinkedPair, parseToolText } from "./_helpers.js";

const schedule = {
  id: 13,
  description: "Nightly",
  ref: "refs/heads/main",
  cron: "0 1 * * *",
  active: true,
  variables: [{ key: "DEPLOY_TOKEN", value: "super-secret", variable_type: "env_var", raw: false }]
};

describe("pipeline schedule tools", () => {
  it("lists schedules with the scope filter", async () => {
    const get = vi.fn().mockResolvedValue([{ id: 13 }]);

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_list_pipeline_schedules",
      { project_id: "group/project", scope: "active", per_page: 20 }
    );

    expect(result.isError).toBeFalsy();
    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/pipeline_schedules", {
      query: { scope: "active", per_page: 20 }
    });
  });

  it("omits schedule variable values unless the server and the call both opt in", async () => {
    const get = vi.fn().mockResolvedValue(schedule);

    const hidden = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { get } }),
        "gitlab_get_pipeline_schedule",
        { project_id: "group/project", pipeline_schedule_id: 13, include_variable_values: true }
      )
    ) as typeof schedule;
    expect(hidden.variables).toEqual([
      { key: "DEPLOY_TOKEN", variable_type: "env_var", raw: false }
    ]);
    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/pipeline_schedules/13");

    const shown = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { get }, allowCiVariableValues: true }),
        "gitlab_get_pipeline_schedule",
        { project_id: "group/project", pipeline_schedule_id: "13", include_variable_values: true }
      )
    ) as typeof schedule;
    expect(shown.variables[0]?.value).toBe("super-secret");
  });

  it("creates schedules with typed inputs and lists triggered pipelines", async () => {
    const post = vi.fn().mockResolvedValue({ id: 14 });
    const get = vi.fn().mockResolvedValue([]);
    const context = buildContext({ gitlabStub: { post, get } });

    await callToolWithContext(context, "gitlab_create_pipeline_schedule", {
      project_id: "group/project",
      description: "Nightly",
      ref: "main",
      cron: "0 1 * * *",
      cron_timezone: "UTC",
      active: "false",
      inputs: [{ name: "deploy_strategy", value: "blue-green" }]
    });
    await callToolWithContext(context, "gitlab_list_pipeline_schedule_pipelines", {
      project_id: "group/project",
      pipeline_schedule_id: "14",
      status: "failed",
      sort: "desc"
    });

    const [path, options] = post.mock.calls[0] as [string, { body: string }];
    expect(path).toBe("/projects/group%2Fproject/pipeline_schedules");
    expect(JSON.parse(options.body)).toEqual({
      description: "Nightly",
      ref: "main",
      cron: "0 1 * * *",
      cron_timezone: "UTC",
      active: false,
      inputs: [{ name: "deploy_strategy", value: "blue-green" }]
    });
    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/pipeline_schedules/14/pipelines", {
      query: { status: "failed", sort: "desc" }
    });
  });

  it("updates, plays, takes ownership of, and deletes schedules", async () => {
    const put = vi.fn().mockResolvedValue({ id: 13 });
    const post = vi.fn().mockResolvedValue({ message: "201 Created" });
    const del = vi.fn().mockResolvedValue({ id: 13 });
    const context = buildContext({ gitlabStub: { put, post, delete: del } });

    await callToolWithContext(context, "gitlab_update_pipeline_schedule", {
      project_id: "group/project",
      pipeline_schedule_id: "13",
      active: false,
      inputs: [{ name: "deploy_strategy", destroy: true }]
    });
    await callToolWithContext(context, "gitlab_play_pipeline_schedule", {
      project_id: "group/project",
      pipeline_schedule_id: "13"
    });
    await callToolWithContext(context, "gitlab_take_ownership_pipeline_schedule", {
      project_id: "group/project",
      pipeline_schedule_id: "13"
    });
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_pipeline_schedule", {
        project_id: "group/project",
        pipeline_schedule_id: "13"
      })
    );

    expect(JSON.parse((put.mock.calls[0] as [string, { body: string }])[1].body)).toEqual({
      active: false,
      inputs: [{ name: "deploy_strategy", destroy: true }]
    });
    expect(post.mock.calls.map((call) => call[0])).toEqual([
      "/projects/group%2Fproject/pipeline_schedules/13/play",
      "/projects/group%2Fproject/pipeline_schedules/13/take_ownership"
    ]);
    expect(del).toHaveBeenCalledWith("/projects/group%2Fproject/pipeline_schedules/13");
    expect(deleted).toMatchObject({ status: "deleted", pipeline_schedule_id: "13" });
  });

  it("rejects an empty schedule update before calling GitLab", async () => {
    const put = vi.fn();

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { put } }),
      "gitlab_update_pipeline_schedule",
      { project_id: "group/project", pipeline_schedule_id: "13" }
    );

    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("hides schedule variable tools until CI variable tools are enabled", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(buildContext());
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_get_pipeline_schedule");
      expect(names).not.toContain("gitlab_create_pipeline_schedule_variable");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("never returns or echoes schedule variable values on mutation", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ key: "DEPLOY_TOKEN", value: "super-secret", variable_type: "env_var" });
    const put = vi.fn().mockRejectedValue(new Error("Rejected value super-secret"));
    const context = buildContext({ gitlabStub: { post, put }, enableCiVariableTools: true });

    const created = await callToolWithContext(context, "gitlab_create_pipeline_schedule_variable", {
      project_id: "group/project",
      pipeline_schedule_id: "13",
      key: "DEPLOY_TOKEN",
      value: "super-secret"
    });
    const failed = await callToolWithContext(context, "gitlab_update_pipeline_schedule_variable", {
      project_id: "group/project",
      pipeline_schedule_id: "13",
      key: "DEPLOY_TOKEN",
      value: "super-secret"
    });

    expect(parseToolText(created)).toEqual({ key: "DEPLOY_TOKEN", variable_type: "env_var" });
    expect(JSON.stringify(failed.content)).not.toContain("super-secret");
    expect(put).toHaveBeenCalledWith(
      "/projects/group%2Fproject/pipeline_schedules/13/variables/DEPLOY_TOKEN",
      expect.objectContaining({ body: JSON.stringify({ value: "super-secret" }) })
    );
  });
});
