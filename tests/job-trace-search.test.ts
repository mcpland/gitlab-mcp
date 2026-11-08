import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../src/lib/gitlab-client.js";
import { cleanJobTraceLine, searchJobTrace } from "../src/lib/job-trace-search.js";
import { buildContext, callToolWithContext } from "./integration/_helpers.js";

const ESC = "\u001b";

describe("searchJobTrace", () => {
  it("strips ANSI escapes and collapsible section markers", () => {
    expect(
      cleanJobTraceLine(
        `section_start:1700000000:step_script[collapsed=true]\r${ESC}[0K${ESC}[32;1mRunning tests${ESC}[0;m\r`
      )
    ).toBe("Running tests");
  });

  it("matches any substring case-insensitively and merges overlapping context", () => {
    const trace = ["setup", "compile", "ERROR: one", "retry", "error: two", "done", "cleanup"].join(
      "\n"
    );

    const result = searchJobTrace(trace, { patterns: ["error"], contextLines: 1 });

    expect(result).toMatchObject({ totalMatches: 2, returnedMatches: 2, truncated: false });
    expect(result.text).toBe(
      [
        "--- lines 2-6 of 7 ---",
        " 2: compile",
        ">3: ERROR: one",
        " 4: retry",
        ">5: error: two",
        " 6: done"
      ].join("\n")
    );
  });

  it("honors case sensitivity, multiple patterns, and max_matches", () => {
    const trace = ["Error A", "error b", "FAILED c", "ok", "failed d"].join("\n");

    expect(searchJobTrace(trace, { patterns: ["Error"], caseSensitive: true }).totalMatches).toBe(
      1
    );

    const capped = searchJobTrace(trace, {
      patterns: ["error", "failed"],
      contextLines: 0,
      maxMatches: 2
    });
    expect(capped).toMatchObject({ totalMatches: 4, returnedMatches: 2, truncated: true });
    expect(capped.text).toContain(">1: Error A");
    expect(capped.text).toContain(">2: error b");
    expect(capped.text).not.toContain("FAILED");
  });

  it("treats regex metacharacters literally", () => {
    const trace = ["(a|aa)+ literal", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!"].join("\n");

    expect(searchJobTrace(trace, { patterns: ["(a|aa)+"], contextLines: 0 }).totalMatches).toBe(1);
  });
});

describe("job trace search through the client and tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns only matching lines with the untrusted-data notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(["step 1", "npm ERR! missing script", "step 3"].join("\n"), {
            status: 200,
            headers: { "content-type": "text/plain" }
          })
      )
    );
    const client = new GitLabClient("https://gitlab.example.com", "token");

    const output = await client.getPipelineJobOutput("group/project", "5", {
      search: { patterns: ["npm err"], contextLines: 0 }
    });

    expect(output).toContain("Untrusted CI job trace");
    expect(output).toContain("[1 matching line(s); showing 1.");
    expect(output).toContain(">2: npm ERR! missing script");
    expect(output).not.toContain("step 1");
  });

  it("passes search options from the tool call and ignores a blank search", async () => {
    const getPipelineJobOutput = vi.fn().mockResolvedValue("ok");
    const context = buildContext({ gitlabStub: { getPipelineJobOutput } });

    await callToolWithContext(context, "gitlab_get_pipeline_job_output", {
      project_id: "group/project",
      job_id: "5",
      search: ["error", "failed"],
      case_sensitive: true,
      context_lines: 2,
      max_matches: 5
    });
    await callToolWithContext(context, "gitlab_get_pipeline_job_output", {
      project_id: "group/project",
      job_id: "5",
      search: "",
      limit: 50
    });

    expect(getPipelineJobOutput).toHaveBeenNthCalledWith(1, "group/project", "5", {
      limit: undefined,
      offset: undefined,
      search: { patterns: ["error", "failed"], caseSensitive: true, contextLines: 2, maxMatches: 5 }
    });
    expect(getPipelineJobOutput).toHaveBeenNthCalledWith(2, "group/project", "5", {
      limit: 50,
      offset: undefined
    });
  });
});
