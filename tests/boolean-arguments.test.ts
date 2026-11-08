import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { booleanLikeSchema, optionalBooleanLikeSchema } from "../src/lib/tool-schema.js";
import { getGitLabToolDefinitions } from "../src/tools/gitlab.js";
import { buildContext, createLinkedPair } from "./integration/_helpers.js";

describe("boolean-like tool arguments", () => {
  it("parses string and numeric spellings without inverting false", () => {
    expect(booleanLikeSchema.parse(true)).toBe(true);
    expect(booleanLikeSchema.parse(false)).toBe(false);
    expect(booleanLikeSchema.parse("true")).toBe(true);
    expect(booleanLikeSchema.parse(" FALSE ")).toBe(false);
    expect(booleanLikeSchema.parse("1")).toBe(true);
    expect(booleanLikeSchema.parse("0")).toBe(false);
    expect(booleanLikeSchema.parse(1)).toBe(true);
    expect(booleanLikeSchema.parse(0)).toBe(false);
  });

  it("rejects values that are not recognizable booleans", () => {
    for (const value of ["", "yes", "no", "off", 2, -1, {}, []]) {
      expect(booleanLikeSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it("keeps omitted and null optional values unset", () => {
    expect(optionalBooleanLikeSchema.parse(undefined)).toBeUndefined();
    expect(optionalBooleanLikeSchema.parse(null)).toBeNull();
  });

  it("never registers a coercing boolean that turns 'false' into true", () => {
    expect(containsCoercedBoolean(z.coerce.boolean().nullable().optional())).toBe(true);

    const offenders: string[] = [];
    for (const definition of getGitLabToolDefinitions()) {
      for (const [argument, schema] of Object.entries(definition.inputSchema ?? {})) {
        if (containsCoercedBoolean(schema)) {
          offenders.push(`${definition.name}.${argument}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("passes confidential: 'false' through a tool call as false", async () => {
    const createIssue = vi.fn().mockResolvedValue({ iid: 1 });
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { createIssue } })
    );

    try {
      const accepted = await client.callTool({
        name: "gitlab_create_issue",
        arguments: { project_id: "group/project", title: "Bug", confidential: "false" }
      });
      expect(accepted.isError).toBeFalsy();
      expect(createIssue).toHaveBeenCalledWith(
        "group/project",
        expect.objectContaining({ confidential: false })
      );

      const rejected = await client.callTool({
        name: "gitlab_create_issue",
        arguments: { project_id: "group/project", title: "Bug", confidential: "maybe" }
      });
      expect(rejected.isError).toBe(true);
      expect(createIssue).toHaveBeenCalledTimes(1);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

function containsCoercedBoolean(schema: z.ZodTypeAny, seen = new Set<unknown>()): boolean {
  if (seen.has(schema)) {
    return false;
  }
  seen.add(schema);

  const def = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (!def) {
    return false;
  }

  if (def.type === "boolean" && def.coerce === true) {
    return true;
  }

  const children: unknown[] = [def.innerType, def.in, def.out, def.element, def.valueType];
  if (Array.isArray(def.options)) {
    children.push(...def.options);
  }
  if (def.shape && typeof def.shape === "object") {
    children.push(...Object.values(def.shape as Record<string, unknown>));
  }

  return children.some(
    (child) =>
      typeof child === "object" &&
      child !== null &&
      containsCoercedBoolean(child as z.ZodTypeAny, seen)
  );
}
