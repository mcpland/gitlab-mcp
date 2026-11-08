import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { attachPaginationMetadata, getPaginationMetadata } from "../src/lib/pagination.js";
import { ResponseMasker } from "../src/lib/response-masking.js";
import { buildContext, callToolWithContext } from "./integration/_helpers.js";

const TOKEN = "glpat-AbCdEfGhIjKlMnOpQrStUv";

describe("ResponseMasker", () => {
  it("masks GitLab tokens by default and other builtins on request", () => {
    const defaults = ResponseMasker.fromPolicy({ version: 1 });
    expect(defaults.maskText(`token ${TOKEN} from 10.1.2.3`)).toBe(
      "token [token masked] from 10.1.2.3"
    );

    const strict = ResponseMasker.fromPolicy({
      version: 1,
      builtins: {
        ipv4: { enabled: true },
        ipv6: { enabled: true, replacement: "[ip$]" },
        email: { enabled: true }
      }
    });
    expect(strict.maskText("10.1.2.3 fe80:0:0:0:1:2:3:4 ops@example.com")).toBe(
      "[IP address] [ip$] [email]"
    );
  });

  it("applies keyword and regex rules", () => {
    const masker = ResponseMasker.fromPolicy({
      version: 1,
      builtins: { "gitlab-token": { enabled: false } },
      rules: [
        { id: "customer", type: "keyword", match: "Acme Corp", replacement: "$Customer" },
        { id: "case", type: "keyword", match: "secret", replacement: "***", case_sensitive: false },
        { id: "ticket", type: "regex", pattern: "TICKET-(\\d+)", replacement: "TICKET-#" }
      ]
    });

    expect(masker.maskText(`Acme Corp SECRET TICKET-42 ${TOKEN}`)).toBe(
      `$Customer *** TICKET-# ${TOKEN}`
    );
  });

  it("masks nested values without touching keys and keeps pagination metadata", () => {
    const masker = ResponseMasker.fromPolicy({ version: 1 });
    const value = attachPaginationMetadata([{ [TOKEN]: TOKEN, nested: { list: [TOKEN, 1] } }], {
      next_page: 2
    });

    const masked = masker.maskValue(value);

    expect(masked).toEqual([
      { [TOKEN]: "[token masked]", nested: { list: ["[token masked]", 1] } }
    ]);
    expect(getPaginationMetadata(masked)).toEqual({ next_page: 2 });
  });

  it("rejects unsafe or malformed policies without echoing patterns", () => {
    const invalid: Array<[unknown, string]> = [
      [{ version: 2 }, "version 1"],
      [{ version: 1, builtins: { phone: { enabled: true } } }, "Unknown masking builtin"],
      [
        { version: 1, rules: [{ id: "x", type: "regex", pattern: "(a+)+$", replacement: "" }] },
        "nested quantifiers"
      ],
      [
        {
          version: 1,
          rules: [{ id: "y", type: "regex", pattern: "a", flags: "y", replacement: "" }]
        },
        "flags"
      ],
      [
        { version: 1, rules: [{ id: "z", type: "regex", pattern: "(", replacement: "" }] },
        "invalid regular expression"
      ],
      [
        { version: 1, rules: [{ id: "k", type: "keyword", match: "", replacement: "" }] },
        "non-empty match"
      ]
    ];

    for (const [policy, message] of invalid) {
      expect(() => ResponseMasker.fromPolicy(policy), message).toThrow(message);
    }
  });

  it("loads a policy file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gitlab-mcp-mask-"));
    try {
      const file = path.join(directory, "mask.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          rules: [{ id: "a", type: "keyword", match: "x", replacement: "y" }]
        })
      );
      expect(ResponseMasker.fromFile(file).maskText("x")).toBe("y");

      writeFileSync(file, "{not json");
      expect(() => ResponseMasker.fromFile(file)).toThrow("valid JSON");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("masking in tool calls", () => {
  it("masks successful results and error text", async () => {
    const masker = ResponseMasker.fromPolicy({
      version: 1,
      rules: [{ id: "customer", type: "keyword", match: "Acme Corp", replacement: "[customer]" }]
    });
    const getIssue = vi.fn().mockResolvedValue({ iid: 1, description: `Acme Corp uses ${TOKEN}` });
    const getProject = vi.fn().mockRejectedValue(new Error("Acme Corp project is archived"));
    const context = buildContext({ gitlabStub: { getIssue, getProject } });
    context.responseMasker = masker;

    const issue = await callToolWithContext(context, "gitlab_get_issue", {
      project_id: "group/project",
      issue_iid: "1"
    });
    const failed = await callToolWithContext(context, "gitlab_get_project", {
      project_id: "group/project"
    });

    const issueText = JSON.stringify(issue);
    expect(issueText).toContain("[customer] uses [token masked]");
    expect(issueText).not.toContain("Acme Corp");
    expect(issueText).not.toContain(TOKEN);
    expect(JSON.stringify(failed.content)).toContain("[customer] project is archived");
  });
});
