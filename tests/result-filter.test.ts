import { describe, expect, it, vi } from "vitest";

import { attachPaginationMetadata } from "../src/lib/pagination.js";
import { ResponseMasker } from "../src/lib/response-masking.js";
import { applyJmespath, assertValidJmespath } from "../src/lib/result-filter.js";
import {
  buildContext,
  callToolWithContext,
  createLinkedPair,
  parseToolText
} from "./integration/_helpers.js";

describe("JMESPath helpers", () => {
  it("validates syntax and projects JSON values", () => {
    expect(() => assertValidJmespath("[].{iid: iid}")).not.toThrow();
    expect(() => assertValidJmespath("[?state==")).toThrow("Invalid jmespath expression");
    expect(applyJmespath([{ iid: 1, title: "a" }], "[].iid")).toEqual({ ok: true, value: [1] });
  });

  it("reports runtime failures instead of throwing", () => {
    expect(applyJmespath({ a: 1 }, "sort_by(@, &name)")).toMatchObject({ ok: false });
  });
});

describe("jmespath tool argument", () => {
  const issues = () =>
    attachPaginationMetadata(
      [
        { iid: 1, title: "Bug", state: "opened", description: "long text" },
        { iid: 2, title: "Feature", state: "closed", description: "long text" }
      ],
      { next_page: 2 }
    );

  it("is only advertised when GITLAB_ENABLE_JMESPATH is on", async () => {
    for (const enableJmespath of [false, true]) {
      const { client, clientTransport, serverTransport } = await createLinkedPair(
        buildContext({ enableJmespath })
      );
      try {
        const tool = (await client.listTools()).tools.find(
          (item) => item.name === "gitlab_list_issues"
        );
        expect(Boolean(tool?.inputSchema.properties?.jmespath), String(enableJmespath)).toBe(
          enableJmespath
        );
      } finally {
        await clientTransport.close();
        await serverTransport.close();
      }
    }
  });

  it("projects results, keeps pagination, and never forwards the argument to GitLab", async () => {
    const listIssues = vi.fn().mockImplementation(async () => issues());

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { listIssues }, enableJmespath: true }),
      "gitlab_list_issues",
      { project_id: "group/project", jmespath: "[?state=='opened'].{iid: iid, title: title}" }
    );

    expect(parseToolText(result)).toEqual([{ iid: 1, title: "Bug" }]);
    expect(
      (result.structuredContent as { meta?: { pagination?: unknown } }).meta?.pagination
    ).toMatchObject({ next_page: 2 });
    expect(JSON.stringify(listIssues.mock.calls)).not.toContain("jmespath");
  });

  it("rejects an invalid expression before running the tool", async () => {
    const createIssue = vi.fn();

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { createIssue }, enableJmespath: true }),
      "gitlab_create_issue",
      { project_id: "group/project", title: "Bug", jmespath: "[?" }
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Invalid jmespath expression");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("returns the unfiltered result with a note when evaluation fails", async () => {
    const getProject = vi.fn().mockResolvedValue({ id: 1, name: "p" });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { getProject }, enableJmespath: true }),
      "gitlab_get_project",
      { project_id: "group/project", jmespath: "sort_by(@, &name)" }
    );

    expect(result.isError).toBeFalsy();
    expect(parseToolText(result)).toEqual({ id: 1, name: "p" });
    expect(
      (result.structuredContent as { meta?: { jmespath_error?: string } }).meta?.jmespath_error
    ).toContain("unfiltered result");
  });

  it("filters masked values so predicates cannot probe masked content", async () => {
    const getIssue = vi
      .fn()
      .mockResolvedValue({ iid: 1, description: "token glpat-AbCdEfGhIjKlMnOpQrStUv" });
    const context = buildContext({ gitlabStub: { getIssue }, enableJmespath: true });
    context.responseMasker = ResponseMasker.fromPolicy({ version: 1 });

    const result = await callToolWithContext(context, "gitlab_get_issue", {
      project_id: "group/project",
      issue_iid: "1",
      jmespath: "contains(description, 'glpat-')"
    });

    expect(parseToolText(result)).toBe(false);
  });
});
