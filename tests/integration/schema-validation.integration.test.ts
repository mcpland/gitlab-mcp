/**
 * Integration tests for Zod schema enforcement through the full MCP protocol.
 *
 * These tests verify that the MCP SDK's schema validation layer (backed by Zod)
 * correctly handles various input edge cases: null preprocessing, missing
 * required fields, invalid enum values, wrong types, and extra fields.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, createLinkedPair } from "./_helpers.js";

/* ------------------------------------------------------------------ */
/*  Null preprocessing                                                 */
/* ------------------------------------------------------------------ */

describe("Schema validation: null preprocessing", () => {
  it("treats null for optional string fields as undefined", async () => {
    const listProjects = vi.fn().mockResolvedValue([]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listProjects } })
    );

    try {
      // `search: null` should be preprocessed to undefined by optionalString
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: { search: null }
      });

      expect(result.isError).toBeFalsy();
      expect(listProjects).toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Valid args pass through                                            */
/* ------------------------------------------------------------------ */

describe("Schema validation: valid args pass through", () => {
  it("does not error on well-formed args", async () => {
    const listProjects = vi.fn().mockResolvedValue([{ id: 1, name: "proj" }]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listProjects } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: {
          search: "hello",
          membership: true,
          page: 1,
          per_page: 20,
          visibility: "public"
        }
      });

      expect(result.isError).toBeFalsy();
      expect(listProjects).toHaveBeenCalled();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Extra unknown fields                                               */
/* ------------------------------------------------------------------ */

describe("Schema validation: extra unknown fields", () => {
  it("ignores extra fields gracefully", async () => {
    const listProjects = vi.fn().mockResolvedValue([]);

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listProjects } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: {
          search: "test",
          totally_fake_field: "should be ignored"
        }
      });

      // Should either succeed or fail gracefully — not crash
      // MCP SDK + Zod may strip or pass extra fields
      expect(result.content).toBeDefined();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Required string missing                                            */
/* ------------------------------------------------------------------ */

describe("Schema validation: required string missing", () => {
  it("returns error when required field is missing", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { getFileContents: vi.fn() } })
    );

    try {
      // gitlab_get_file_contents requires file_path (z.string().min(1))
      const result = await client.callTool({
        name: "gitlab_get_file_contents",
        arguments: { project_id: "group/project" }
      });

      // Should return an error — either from Zod validation or from the handler
      expect(result.isError).toBe(true);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Invalid enum value                                                 */
/* ------------------------------------------------------------------ */

describe("Schema validation: invalid enum value", () => {
  it("returns error for invalid visibility enum", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listProjects: vi.fn() } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: { visibility: "invalid_value" }
      });

      expect(result.isError).toBe(true);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Wrong type                                                         */
/* ------------------------------------------------------------------ */

describe("Schema validation: wrong type", () => {
  it("returns error when string is passed for a number field", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ gitlabStub: { listProjects: vi.fn() } })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_list_projects",
        arguments: { page: "not-a-number" }
      });

      expect(result.isError).toBe(true);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Empty string for required field                                    */
/* ------------------------------------------------------------------ */

describe("Schema validation: empty string for required field", () => {
  it("returns error when file_path is empty string (min(1))", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({
        gitlabStub: {
          getProject: vi.fn().mockResolvedValue({ default_branch: "main" }),
          getFileContents: vi.fn()
        }
      })
    );

    try {
      const result = await client.callTool({
        name: "gitlab_get_file_contents",
        arguments: { project_id: "group/project", file_path: "" }
      });

      expect(result.isError).toBe(true);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
