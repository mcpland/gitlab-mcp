/**
 * Vulnerability triage tools.
 */
import { describe, expect, it, vi } from "vitest";

import { toolsetsForTool } from "../../src/lib/toolsets.js";
import { toVulnerabilityGid } from "../../src/tools/vulnerabilities.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

type GraphqlCall = [string, Record<string, unknown>];

const vulnerability = {
  id: "gid://gitlab/Vulnerability/77",
  title: "SQL injection",
  severity: "HIGH",
  state: "DETECTED",
  project: { id: "gid://gitlab/Project/42", fullPath: "group/project" }
};

describe("vulnerability identifiers", () => {
  it("accepts numeric and vulnerability global IDs only", () => {
    expect(toVulnerabilityGid("77")).toBe("gid://gitlab/Vulnerability/77");
    expect(toVulnerabilityGid("gid://gitlab/Vulnerability/77")).toBe(
      "gid://gitlab/Vulnerability/77"
    );
    expect(() => toVulnerabilityGid("gid://gitlab/Project/1")).toThrow("vulnerability_id");
  });
});

describe("vulnerability tools", () => {
  it("lists vulnerabilities with upper-cased GraphQL filters and cursor paging", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({
      data: {
        project: {
          vulnerabilities: {
            nodes: [vulnerability],
            pageInfo: { endCursor: "cursor-2", hasNextPage: true }
          }
        }
      }
    });

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { executeGraphql } }),
        "gitlab_list_project_vulnerabilities",
        {
          project_id: "group/project",
          severity: ["critical", "high"],
          state: "detected",
          report_type: "secret_detection",
          first: 50,
          after: "cursor-1"
        }
      )
    );

    expect((executeGraphql.mock.calls as GraphqlCall[])[0]?.[1]).toEqual({
      fullPath: "group/project",
      state: ["DETECTED"],
      severity: ["CRITICAL", "HIGH"],
      reportType: ["SECRET_DETECTION"],
      first: 50,
      after: "cursor-1"
    });
    expect(result).toEqual({
      vulnerabilities: [vulnerability],
      page_info: { end_cursor: "cursor-2", has_next_page: true }
    });
  });

  it("resolves a numeric project to its path before listing", async () => {
    const getProject = vi.fn().mockResolvedValue({ id: 42, path_with_namespace: "group/project" });
    const executeGraphql = vi
      .fn()
      .mockResolvedValue({ data: { project: { vulnerabilities: { nodes: [], pageInfo: {} } } } });

    await callToolWithContext(
      buildContext({ gitlabStub: { getProject, executeGraphql } }),
      "gitlab_list_project_vulnerabilities",
      { project_id: "42" }
    );

    expect(getProject).toHaveBeenCalledWith("42");
    expect((executeGraphql.mock.calls as GraphqlCall[])[0]?.[1]).toMatchObject({
      fullPath: "group/project",
      first: 20
    });
  });

  it("returns a vulnerability only when it belongs to the requested project", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({ data: { vulnerability } });
    const context = buildContext({ gitlabStub: { executeGraphql } });

    const own = await callToolWithContext(context, "gitlab_get_vulnerability", {
      project_id: "42",
      vulnerability_id: "77"
    });
    const foreign = await callToolWithContext(context, "gitlab_get_vulnerability", {
      project_id: "other/project",
      vulnerability_id: "77"
    });

    expect(parseToolText(own)).toEqual(vulnerability);
    expect(foreign.isError).toBe(true);
    expect(JSON.stringify(foreign.content)).toContain("was not found in project");
  });

  it("dismisses after the ownership check and surfaces mutation errors", async () => {
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({ data: { vulnerability } })
      .mockResolvedValueOnce({
        data: {
          vulnerabilityDismiss: {
            vulnerability: { id: vulnerability.id, state: "DISMISSED" },
            errors: []
          }
        }
      })
      .mockResolvedValueOnce({ data: { vulnerability } })
      .mockResolvedValueOnce({
        data: { vulnerabilityConfirm: { vulnerability: null, errors: ["Not allowed"] } }
      });
    const context = buildContext({ gitlabStub: { executeGraphql } });

    const dismissed = parseToolText(
      await callToolWithContext(context, "gitlab_dismiss_vulnerability", {
        project_id: "group/project",
        vulnerability_id: "77",
        reason: "false_positive",
        comment: "Test fixture"
      })
    );
    const confirmFailed = await callToolWithContext(context, "gitlab_confirm_vulnerability", {
      project_id: "group/project",
      vulnerability_id: "77"
    });

    expect(dismissed).toEqual({ id: vulnerability.id, state: "DISMISSED" });
    expect((executeGraphql.mock.calls as GraphqlCall[])[1]?.[1]).toEqual({
      input: {
        id: "gid://gitlab/Vulnerability/77",
        dismissalReason: "FALSE_POSITIVE",
        comment: "Test fixture"
      }
    });
    expect(confirmFailed.isError).toBe(true);
    expect(JSON.stringify(confirmFailed.content)).toContain("Not allowed");
  });

  it("belongs to the vulnerabilities toolset", () => {
    expect(toolsetsForTool("gitlab_dismiss_vulnerability")).toEqual(["vulnerabilities"]);
    expect(toolsetsForTool("gitlab_list_project_vulnerabilities")).toEqual(
      expect.arrayContaining(["vulnerabilities", "projects"])
    );
  });
});
